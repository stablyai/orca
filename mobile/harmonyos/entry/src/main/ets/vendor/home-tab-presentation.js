var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  TUI_AGENT_DISPLAY_NAMES: () => TUI_AGENT_DISPLAY_NAMES,
  describeAutomationSchedule: () => describeAutomationSchedule,
  formatResetCountdown: () => formatResetCountdown,
  installUtf8Encoder: () => installUtf8Encoder
});
module.exports = __toCommonJS(stdin_exports);

// src/shared/automations/scheduling/automation-cron-occurrence.ts
var CRON_SCAN_DAYS = 9 * 366;
function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
function addLocalDays(day, days) {
  const date = new Date(day);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
function cronDateMatches(rule, timestamp) {
  const date = new Date(timestamp);
  if (!rule.months.has(date.getMonth() + 1)) {
    return false;
  }
  const dayOfMonthMatches = rule.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = rule.daysOfWeek.has(date.getDay());
  if (rule.dayOfMonthRestricted && rule.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}
function cronHasPossibleOccurrence(rule, anchor) {
  let day = startOfLocalDay(anchor);
  for (let i = 0; i < CRON_SCAN_DAYS; i += 1) {
    if (cronDateMatches(rule, day)) {
      return true;
    }
    day = addLocalDays(day, 1);
  }
  return false;
}

// harmony:utf8
var encode;
function installUtf8Encoder(encoder) {
  encode = encoder;
}
function isClipboardTextByteLengthOverLimit(text, maxBytes) {
  return text.length > maxBytes || encode(text).byteLength > maxBytes;
}

// src/shared/automations/scheduling/automation-cron-field-parsing.ts
var MONTH_NAMES = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
};
var DAY_NAMES = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
};
function parseCronNumber(value, names, field) {
  const normalized = value.toUpperCase();
  const named = names?.[normalized];
  const parsed = named ?? Number(normalized);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron ${field}.`);
  }
  return parsed;
}
function parseCronField(args) {
  const result = /* @__PURE__ */ new Set();
  for (const rawPart of args.value.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`Invalid cron ${args.field}.`);
    }
    const stepParts = part.split("/");
    if (stepParts.length > 2) {
      throw new Error(`Invalid cron ${args.field}.`);
    }
    const [rangePart, stepPart] = stepParts;
    if (!rangePart) {
      throw new Error(`Invalid cron ${args.field}.`);
    }
    const step = stepPart === void 0 ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${args.field}.`);
    }
    const domainSize = args.distinctValueCount ?? args.max - args.min + 1;
    if (args.rejectOversizedStep && step > domainSize) {
      throw new Error(`Cron ${args.field} step must be between 1 and ${domainSize}.`);
    }
    let start;
    let end;
    if (rangePart === "*") {
      start = args.min;
      end = args.max;
    } else if (rangePart.includes("-")) {
      const rangeParts = rangePart.split("-");
      if (rangeParts.length !== 2 || !rangeParts[0] || !rangeParts[1]) {
        throw new Error(`Invalid cron ${args.field}.`);
      }
      const [startPart, endPart] = rangeParts;
      start = parseCronNumber(startPart, args.names ?? null, args.field);
      end = parseCronNumber(endPart, args.names ?? null, args.field);
    } else {
      start = parseCronNumber(rangePart, args.names ?? null, args.field);
      end = stepPart === void 0 ? start : args.max;
    }
    const normalizedStart = args.normalize?.(start) ?? start;
    const normalizedEnd = args.normalize?.(end) ?? end;
    if (start < args.min || start > args.max || end < args.min || end > args.max || normalizedStart < args.min || normalizedStart > args.max || normalizedEnd < args.min || normalizedEnd > args.max || start > end) {
      throw new Error(`Invalid cron ${args.field}.`);
    }
    for (let value = start; value <= end; value += step) {
      result.add(args.normalize?.(value) ?? value);
    }
  }
  if (result.size === 0) {
    throw new Error(`Invalid cron ${args.field}.`);
  }
  return result;
}
function isCronDayFieldRestricted(field) {
  return !field.split(",").some((term) => term.split("/")[0].trim() === "*");
}

// src/shared/automations/scheduling/automation-schedule-parsing.ts
var AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 2 * 1024;
var DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR"];
function parseRrule(rrule) {
  const entries = /* @__PURE__ */ new Map();
  for (const part of rrule.split(";")) {
    const [key, value] = part.split("=");
    if (key && value) {
      entries.set(key.toUpperCase(), value);
    }
  }
  const freq = entries.get("FREQ");
  if (freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY") {
    throw new Error("Unsupported automation recurrence.");
  }
  const byHour = Number(entries.get("BYHOUR") ?? "9");
  const byMinute = Number(entries.get("BYMINUTE") ?? "0");
  if (!Number.isInteger(byHour) || byHour < 0 || byHour > 23) {
    throw new Error("Invalid recurrence hour.");
  }
  if (!Number.isInteger(byMinute) || byMinute < 0 || byMinute > 59) {
    throw new Error("Invalid recurrence minute.");
  }
  const byDay = (entries.get("BYDAY") ?? "").split(",").filter(Boolean);
  if (freq === "WEEKLY" && (byDay.length === 0 || byDay.some((day) => !DAY_CODES.includes(day)))) {
    throw new Error("Invalid recurrence day.");
  }
  return { kind: "rrule", freq, byDay, byHour, byMinute };
}
function parseCronExpression(expression, options = {}) {
  const parts = getAutomationCronExpressionFields(expression, 6);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must have five fields.");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const rejectOversizedStep = options.rejectOversizedStep ?? false;
  return {
    kind: "cron",
    minutes: parseCronField({
      value: minute,
      min: 0,
      max: 59,
      field: "minute",
      rejectOversizedStep
    }),
    hours: parseCronField({ value: hour, min: 0, max: 23, field: "hour", rejectOversizedStep }),
    daysOfMonth: parseCronField({
      value: dayOfMonth,
      min: 1,
      max: 31,
      field: "day of month",
      rejectOversizedStep
    }),
    months: parseCronField({
      value: month,
      min: 1,
      max: 12,
      field: "month",
      names: MONTH_NAMES,
      rejectOversizedStep
    }),
    daysOfWeek: parseCronField({
      value: dayOfWeek,
      min: 0,
      max: 7,
      field: "day of week",
      names: DAY_NAMES,
      normalize: (value) => value === 7 ? 0 : value,
      distinctValueCount: 7,
      rejectOversizedStep
    }),
    dayOfMonthRestricted: isCronDayFieldRestricted(dayOfMonth),
    dayOfWeekRestricted: isCronDayFieldRestricted(dayOfWeek)
  };
}
function getAutomationCronExpressionFields(expression, maxFields = 5) {
  if (isClipboardTextByteLengthOverLimit(expression, AUTOMATION_CRON_EXPRESSION_MAX_BYTES)) {
    return [];
  }
  const fields = [];
  let tokenStart = -1;
  for (let index = 0; index <= expression.length; index += 1) {
    const isEnd = index === expression.length;
    if (!isEnd && !isAutomationCronFieldWhitespace(expression.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      continue;
    }
    if (tokenStart !== -1) {
      fields.push(expression.slice(tokenStart, index));
      tokenStart = -1;
      if (fields.length >= maxFields) {
        break;
      }
    }
  }
  return fields;
}
function isAutomationCronFieldWhitespace(code) {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function parseSchedule(schedule, options = {}) {
  const trimmed = schedule.trim();
  if (trimmed.includes("=")) {
    return parseRrule(trimmed);
  }
  return parseCronExpression(trimmed, options);
}
function parseAutomationRrule(rrule) {
  const rule = parseRrule(rrule);
  if (rule.freq === "HOURLY") {
    return { preset: "hourly", hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 };
  }
  if (rule.freq === "DAILY") {
    return { preset: "daily", hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 };
  }
  if (rule.byDay.join(",") === WEEKDAY_CODES.join(",")) {
    return { preset: "weekdays", hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 };
  }
  if (rule.byDay.length !== 1) {
    throw new Error("Invalid recurrence day.");
  }
  const dayCode = rule.byDay[0];
  const dayOfWeek = DAY_CODES.indexOf(dayCode);
  if (dayOfWeek === -1) {
    throw new Error("Invalid recurrence day.");
  }
  return {
    preset: "weekly",
    hour: rule.byHour,
    minute: rule.byMinute,
    dayOfWeek
  };
}
function tryParseAutomationRrule(rrule) {
  try {
    return parseAutomationRrule(rrule);
  } catch {
    return null;
  }
}

// src/shared/terminal/output/terminal-control-character-escape.ts
function escapeTerminalControlCharacters(value, escapeLineBreaks = false) {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    if (!escapeLineBreaks && character === "\n" || code >= 32 && code < 127 || code > 159) {
      return character;
    }
    return `\\x${code.toString(16).padStart(2, "0")}`;
  }).join("");
}

// src/shared/automations/scheduling/automation-schedules.ts
var EN_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];
function formatTime(hour, minute) {
  const date = /* @__PURE__ */ new Date();
  date.setHours(hour, minute, 0, 0);
  return new Intl.DateTimeFormat(void 0, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
function getSingleSetValue(values) {
  if (values.size !== 1) {
    return null;
  }
  return values.values().next().value;
}
function setContainsExactly(values, expected) {
  if (values.size !== expected.length) {
    return false;
  }
  return expected.every((value) => values.has(value));
}
function setContainsRange(values, min, max) {
  if (values.size !== max - min + 1) {
    return false;
  }
  for (let value = min; value <= max; value += 1) {
    if (!values.has(value)) {
      return false;
    }
  }
  return true;
}
function classifyParsedCronSchedule(rule) {
  if (!cronHasPossibleOccurrence(rule, Date.now())) {
    return { kind: "invalid", label: "Invalid schedule" };
  }
  const minute = getSingleSetValue(rule.minutes);
  const hour = getSingleSetValue(rule.hours);
  const unrestrictedMonth = setContainsRange(rule.months, 1, 12);
  const everyDayOfMonth = setContainsRange(rule.daysOfMonth, 1, 31);
  const everyDayOfWeek = setContainsRange(rule.daysOfWeek, 0, 6);
  const matchesEitherDayField = rule.dayOfMonthRestricted && rule.dayOfWeekRestricted;
  const everyDay = matchesEitherDayField ? everyDayOfMonth || everyDayOfWeek : everyDayOfMonth && everyDayOfWeek;
  const unrestrictedCalendar = everyDayOfMonth && unrestrictedMonth;
  if (minute !== null && setContainsRange(rule.hours, 0, 23) && unrestrictedMonth && everyDay) {
    return {
      kind: "hourly",
      minute,
      label: `Hourly at :${String(minute).padStart(2, "0")}`
    };
  }
  if (minute !== null && hour !== null && unrestrictedMonth && everyDay) {
    return { kind: "daily", hour, minute, label: `Daily at ${formatTime(hour, minute)}` };
  }
  if (minute !== null && hour !== null && unrestrictedCalendar && !matchesEitherDayField) {
    const time = formatTime(hour, minute);
    if (setContainsExactly(rule.daysOfWeek, [1, 2, 3, 4, 5])) {
      return { kind: "weekdays", hour, minute, label: `Weekdays at ${time}` };
    }
    const dayOfWeek = getSingleSetValue(rule.daysOfWeek);
    if (dayOfWeek !== null) {
      return {
        kind: "weekly",
        hour,
        minute,
        dayOfWeek,
        label: `${EN_DAY_NAMES[dayOfWeek]}s at ${time}`
      };
    }
  }
  return { kind: "custom", label: "Custom schedule" };
}
function toScheduleDescriptor(classification) {
  const { label: _label, ...descriptor } = classification;
  return descriptor;
}
function describeAutomationSchedule(scheduleExpression) {
  try {
    const trimmed = scheduleExpression.trim();
    const schedule = parseSchedule(trimmed);
    if (schedule.kind === "cron") {
      return toScheduleDescriptor(classifyParsedCronSchedule(schedule));
    }
    const rrule = tryParseAutomationRrule(trimmed);
    if (rrule === null) {
      return { kind: "custom", expression: escapeTerminalControlCharacters(trimmed, true) };
    }
    if (rrule.preset === "hourly") {
      return { kind: "hourly", minute: rrule.minute };
    }
    if (rrule.preset === "weekly") {
      return {
        kind: "weekly",
        hour: rrule.hour,
        minute: rrule.minute,
        dayOfWeek: rrule.dayOfWeek
      };
    }
    if (rrule.preset === "weekdays") {
      return { kind: "weekdays", hour: rrule.hour, minute: rrule.minute };
    }
    return { kind: "daily", hour: rrule.hour, minute: rrule.minute };
  } catch {
    return { kind: "invalid" };
  }
}

// src/shared/rate-limit-reset-format.ts
function formatResetDuration(ms) {
  if (ms <= 0) {
    return "now";
  }
  const totalMins = Math.floor(ms / 6e4);
  if (totalMins < 60) {
    return `${totalMins}m`;
  }
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
function formatResetCountdown(ms) {
  const duration = formatResetDuration(ms);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}
var MINUTE_MS = 6e4;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;

// src/shared/agent-launch/catalog/tui-agent-display-names.ts
var TUI_AGENT_DISPLAY_NAMES = {
  claude: "Claude",
  "claude-agent-teams": "Claude Agent Teams",
  codebuddy: "CodeBuddy",
  openclaude: "OpenClaude",
  codex: "Codex",
  devin: "Devin",
  ante: "Ante",
  trae: "Trae",
  muse: "Muse",
  dsh: "DeepSeek Harness",
  zcode: "ZCode",
  autohand: "Autohand Code",
  opencode: "OpenCode",
  opencode2: "OpenCode 2",
  "mimo-code": "MiMo Code",
  pi: "Pi",
  omp: "OMP",
  "prime-agent": "Prime Agent",
  qoder: "Qoder CLI",
  "qoder-cn": "Qoder CLI China",
  gemini: "Gemini",
  antigravity: "Antigravity",
  aider: "Aider",
  goose: "Goose",
  amp: "Amp",
  kilo: "Kilocode",
  kiro: "Kiro",
  crush: "Charm",
  aug: "Auggie",
  cline: "Cline",
  codebuff: "Codebuff",
  freebuff: "Freebuff",
  "command-code": "Command Code",
  continue: "Continue",
  cursor: "Cursor",
  droid: "Droid",
  kimi: "Kimi",
  "mistral-vibe": "Mistral Vibe",
  "qwen-code": "Qwen Code",
  rovo: "Rovo Dev",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  copilot: "GitHub Copilot",
  grok: "Grok",
  jcode: "Jcode"
};
var ALL_TUI_AGENTS = Object.keys(TUI_AGENT_DISPLAY_NAMES);
