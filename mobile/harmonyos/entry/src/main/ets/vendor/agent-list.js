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

// orca-agent-list-entry.ts
var orca_agent_list_entry_exports = {};
__export(orca_agent_list_entry_exports, {
  agentListPreview: () => agentListPreview,
  agentListRowsIn: () => agentListRowsIn,
  agentStatusGroup: () => agentStatusGroup,
  buildAgentList: () => buildAgentList,
  formatAgentTypeLabel: () => formatAgentTypeLabel,
  selectActiveAgents: () => selectActiveAgents,
  selectAgentsNeedingYou: () => selectAgentsNeedingYou,
  summarizeAgentListHosts: () => summarizeAgentListHosts
});
module.exports = __toCommonJS(orca_agent_list_entry_exports);

// src/shared/agent-status/presentation/agent-type-label.ts
var WELL_KNOWN_LABELS = {
  claude: "Claude",
  codebuddy: "CodeBuddy",
  openclaude: "OpenClaude",
  codex: "Codex",
  qoder: "Qoder CLI",
  qodercli: "Qoder CLI",
  gemini: "Gemini",
  antigravity: "Antigravity",
  amp: "Amp",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  opencode2: "OpenCode 2",
  "mimo-code": "MiMo Code",
  cursor: "Cursor",
  aider: "Aider",
  pi: "Pi",
  omp: "OMP",
  "prime-agent": "Prime Agent",
  droid: "Droid",
  "command-code": "Command Code",
  grok: "Grok",
  hermes: "Hermes",
  devin: "Devin",
  ante: "Ante",
  trae: "Trae",
  kimi: "Kimi",
  muse: "Muse",
  zcode: "ZCode",
  dsh: "DeepSeek Harness",
  dsb: "DeepSeek Build",
  jcode: "Jcode"
};
function formatAgentTypeLabel(agentType) {
  if (!agentType || agentType === "unknown") {
    return "Agent";
  }
  return WELL_KNOWN_LABELS[agentType] ?? agentType;
}

// src/shared/wsl-paths.ts
var SLASH_CHAR_CODE = "/".charCodeAt(0);
var BACKSLASH_CHAR_CODE = "\\".charCodeAt(0);

// src/shared/cross-platform-path.ts
var SLASH_CHAR_CODE2 = "/".charCodeAt(0);
function getRuntimePathBasename(value) {
  const trimmed = value.replace(/[\\/]+$/g, "");
  if (!trimmed) {
    return "";
  }
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
}

// src/shared/orca-dispatch-status-prompt.ts
var ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX = "You are working inside Orca, a multi-agent IDE.";
var ORCA_DISPATCH_STATUS_TASK_MARKER = "=== TASK ===";
var ORCA_DISPATCH_PROMPT_LEAD_LINE = "Please carry out this task from my Orca coordinator by following the brief I pasted below.";
var ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24576;
var PASTED_CONTENT_OPEN_TAG = "<pasted_content";
var PASTED_CONTENT_OPEN_TAG_MAX_LENGTH = 64;
function findOrcaDispatchPreambleStart(value) {
  const scanEnd = Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT);
  let start = skipTrimWhitespace(value, 0, scanEnd);
  if (value.startsWith(ORCA_DISPATCH_PROMPT_LEAD_LINE, start)) {
    start = skipTrimWhitespace(value, start + ORCA_DISPATCH_PROMPT_LEAD_LINE.length, scanEnd);
  }
  if (value.startsWith(PASTED_CONTENT_OPEN_TAG, start)) {
    const tagLength = value.slice(start, start + PASTED_CONTENT_OPEN_TAG_MAX_LENGTH).indexOf(">");
    if (tagLength === -1) {
      return -1;
    }
    start = skipTrimWhitespace(value, start + tagLength + 1, scanEnd);
  }
  return start + ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX.length <= scanEnd && value.startsWith(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX, start) ? start : -1;
}
function skipTrimWhitespace(value, from, scanEnd) {
  let index = from;
  while (index < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(index))) {
    index++;
  }
  return index;
}
function findOrcaDispatchTaskMarkerIndex(value) {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const markerIndex = value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER, searchFrom);
    if (markerIndex === -1) {
      break;
    }
    const markerEnd = markerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length;
    const startsLine = markerIndex === 0 || isLineBreak(value.charCodeAt(markerIndex - 1));
    const endsLine = markerEnd === value.length || isLineBreak(value.charCodeAt(markerEnd));
    if (startsLine && endsLine) {
      return markerIndex;
    }
    searchFrom = markerEnd;
  }
  return value.includes("\n") || value.includes("\r") ? -1 : value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER);
}
function isLineBreak(code) {
  return code === 10 || code === 13;
}
function isEcmaTrimWhitespace(code) {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

// src/shared/agent-status/presentation/agent-row-primary-text.ts
var ORCA_DISPATCH_TASK_MARKER = ORCA_DISPATCH_STATUS_TASK_MARKER;
var ORCA_DISPATCH_TASK_ID_MARKER = "Your task ID is:";
var ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT = 512;
var ORCA_DISPATCH_TASK_ID_SCAN_LIMIT = 1024;
var ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT = 32768;
var ATTACHED_FILE_LEAD = /^<file name="([^"]+)/;
var ATTACHED_FILE_CLOSER = "</file>";
var PASTED_DATA_LEAD = /^(?:\{\s*"[^"]*"\s*:|\[\s*\{\s*"|\[\s*"[^"]*"\s*,|<\?xml\s|<!doctype\s)/i;
function isOrcaDispatchPrompt(prompt) {
  return findOrcaDispatchPreambleStart(prompt) !== -1;
}
function orchestrationLabelsMatchLiveDispatch(entry) {
  if (!isOrcaDispatchPrompt(entry.prompt)) {
    return false;
  }
  const orchestrationTaskId = entry.orchestration?.taskId?.trim();
  if (!orchestrationTaskId) {
    return false;
  }
  const liveTaskId = getOrcaDispatchTaskId(entry.prompt);
  if (!liveTaskId) {
    return true;
  }
  return liveTaskId === orchestrationTaskId;
}
function getAgentRowPrimaryText(entry) {
  if (orchestrationLabelsMatchLiveDispatch(entry)) {
    return entry.orchestration?.displayName?.trim() || entry.orchestration?.taskTitle?.trim() || getOrcaDispatchTaskPreview(entry.prompt);
  }
  if (isOrcaDispatchPrompt(entry.prompt)) {
    return getOrcaDispatchTaskPreview(entry.prompt);
  }
  return getAgentPromptLabel(entry.prompt);
}
function getAgentPromptLabel(prompt) {
  const text = prompt.trim();
  const attachedFile = ATTACHED_FILE_LEAD.exec(text);
  if (attachedFile) {
    const closer = text.lastIndexOf(ATTACHED_FILE_CLOSER);
    const afterFiles = closer === -1 ? "" : text.slice(closer + ATTACHED_FILE_CLOSER.length);
    return getAgentPromptLabel(afterFiles) || getRuntimePathBasename(attachedFile[1]);
  }
  return PASTED_DATA_LEAD.test(text) ? "" : text;
}
function getOrcaDispatchTaskId(prompt) {
  const start = findOrcaDispatchPreambleStart(prompt);
  if (start === -1) {
    return null;
  }
  const scan = prompt.slice(start, start + ORCA_DISPATCH_TASK_ID_SCAN_LIMIT);
  const markerIndex = scan.indexOf(ORCA_DISPATCH_TASK_ID_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const afterMarker = scan.slice(markerIndex + ORCA_DISPATCH_TASK_ID_MARKER.length).trimStart();
  const idEnd = afterMarker.search(/\s/);
  const idLine = idEnd === -1 ? afterMarker : afterMarker.slice(0, idEnd);
  return idLine || null;
}
function getOrcaDispatchTaskPreview(prompt) {
  const start = findOrcaDispatchPreambleStart(prompt);
  if (start === -1) {
    return "";
  }
  const scan = prompt.slice(
    start,
    start + ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT + ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT
  );
  const taskMarkerIndex = findOrcaDispatchTaskMarkerIndex(scan);
  if (taskMarkerIndex === -1) {
    return "";
  }
  const taskBodyStart = taskMarkerIndex + ORCA_DISPATCH_TASK_MARKER.length;
  const taskBody = scan.slice(taskBodyStart, taskBodyStart + ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT);
  for (const line of taskBody.split(/\r?\n/)) {
    const preview = line.trim().replace(/\s+/g, " ");
    if (preview) {
      return preview;
    }
  }
  return "";
}

// src/shared/agent-status/presentation/agent-tool-preview.ts
function agentToolPreviewInput(entry, allowsBareInput) {
  const toolInput = entry.toolInput?.trim() ?? "";
  return entry.toolName?.trim() || allowsBareInput ? toolInput : "";
}
function formatAgentToolPreviewLine(entry, allowsBareInput) {
  const toolName = entry.toolName?.trim() ?? "";
  const toolInput = agentToolPreviewInput(entry, allowsBareInput);
  if (toolName && toolInput) {
    return `${toolName}: ${toolInput}`;
  }
  return toolName || toolInput;
}

// src/shared/native-chat/native-chat-visual-directive.ts
var NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER = "::orca-visual{";
var NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH = 512;
var NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH = 128;
var NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH = 120;
var NATIVE_CHAT_VISUAL_MAX_BYTES = 512 * 1024;
var FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;
var WINDOWS_DEVICE_BASE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3]|conin\$|conout\$)$/i;
var ATTRIBUTE_PATTERN = /^([a-z]+)="([^"]*)"/;
var LINE_SPACE = /^[ \t]*/;
function isNativeChatVisualFileName(name) {
  if (name.length === 0 || name.length > NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH || !FILE_NAME_PATTERN.test(name) || name.includes("..")) {
    return false;
  }
  const baseName = name.slice(0, name.indexOf("."));
  return !WINDOWS_DEVICE_BASE_NAME.test(baseName);
}
function isPlainAttributeValue(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || code === 92) {
      return false;
    }
  }
  return true;
}
function stripLineEnding(line) {
  if (line.endsWith("\r\n")) {
    return line.slice(0, -2);
  }
  return line.endsWith("\n") || line.endsWith("\r") ? line.slice(0, -1) : line;
}
function leadingSpaceCount(line) {
  let count = 0;
  while (line[count] === " ") {
    count += 1;
  }
  return count;
}
function parseAttributes(body) {
  const attributes = /* @__PURE__ */ new Map();
  let rest = body.replace(LINE_SPACE, "");
  while (rest.length > 0) {
    const match = ATTRIBUTE_PATTERN.exec(rest);
    if (!match) {
      return null;
    }
    const [whole, key, value] = match;
    if (attributes.has(key) || !isPlainAttributeValue(value)) {
      return null;
    }
    attributes.set(key, value);
    rest = rest.slice(whole.length);
    const separator = LINE_SPACE.exec(rest)?.[0] ?? "";
    if (rest.length > 0 && separator.length === 0) {
      return null;
    }
    rest = rest.slice(separator.length);
  }
  return attributes;
}
function parseNativeChatVisualDirectiveLine(rawLine) {
  const line = stripLineEnding(rawLine);
  if (line.length > NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH || /[\r\n]/.test(line)) {
    return null;
  }
  const indent = leadingSpaceCount(line);
  if (indent > 3 || !line.startsWith(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER, indent)) {
    return null;
  }
  const trimmedEnd = line.replace(/[ \t]+$/, "");
  if (!trimmedEnd.endsWith("}")) {
    return null;
  }
  const body = trimmedEnd.slice(indent + NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER.length, -1);
  const attributes = parseAttributes(body);
  const file = attributes?.get("file");
  if (!attributes || file === void 0 || !isNativeChatVisualFileName(file)) {
    return null;
  }
  const title = attributes.get("title")?.trim() ?? "";
  if (title.length > NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH) {
    return null;
  }
  return { file, title: title.length > 0 ? title : null };
}
var FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
var FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
function withoutNativeChatVisualDirectiveLines(text) {
  if (!text.includes(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)) {
    return text;
  }
  let fence = null;
  let skipBlank = false;
  const kept = [];
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    const blank = bare.trim().length === 0;
    if (skipBlank && blank) {
      skipBlank = false;
      continue;
    }
    skipBlank = false;
    if (fence) {
      const closer = FENCE_CLOSE.exec(bare)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = null;
      }
      kept.push(line);
      continue;
    }
    const opener = FENCE_OPEN.exec(bare)?.[1];
    if (opener) {
      fence = opener;
      kept.push(line);
      continue;
    }
    if (parseNativeChatVisualDirectiveLine(line)) {
      const previous = kept.at(-1);
      skipBlank = previous === void 0 || previous.replace(/\r$/, "").trim().length === 0;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "").replace(/\r$/, "");
}

// mobile/src/agents/agent-list-row-text.ts
function agentListTitle(agent) {
  return agent.conversationName?.trim() || agent.displayName?.trim() || agent.taskTitle?.trim() || getAgentRowPrimaryText({ prompt: agent.prompt }) || formatAgentTypeLabel(agent.agentType);
}
function oneLine(text) {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}
function lastMessage(agent) {
  const message = agent.lastAssistantMessage;
  return message ? oneLine(withoutNativeChatVisualDirectiveLines(message)) : "";
}
function agentListPreview(agent, group, title) {
  const tool = group === null ? "" : oneLine(formatAgentToolPreviewLine(agent, false));
  const preview = group === "needs-you" || group === "working" ? tool || lastMessage(agent) : lastMessage(agent) || tool;
  if (preview) {
    return preview;
  }
  const prompt = oneLine(getAgentRowPrimaryText({ prompt: agent.prompt }));
  return prompt === title ? "" : prompt;
}
function agentListEntryMatches(entry, query) {
  const { agent } = entry;
  return [
    agentListTitle(agent),
    agent.activity?.listed === true ? agent.activity.title : null,
    entry.workspaceName,
    entry.branch,
    entry.repo,
    formatAgentTypeLabel(agent.agentType),
    agent.prompt,
    agent.lastAssistantMessage
  ].some((field) => field?.toLowerCase().includes(query));
}

// src/shared/agent-status/presentation/agent-list-status.ts
var AGENT_LIST_STATUS_RANK = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  failed: 3,
  unconfirmed: 4,
  working: 5,
  monitoring: 6,
  // A user's Stop is not news, so it follows live work, but it is not a finish either.
  interrupted: 7,
  unverifiable: 8,
  done: 9,
  idle: 10
};

// src/shared/agent-status/contracts/agent-status-freshness.ts
var AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1e3;
var AGENT_STATUS_HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
function agentStatusAuthorityObservedAt(entry) {
  return entry.evidenceObservedAt ?? entry.updatedAt;
}
function agentStatusEvidenceObservedAt(entry) {
  return entry.mirroredEvidenceReceivedAt ?? agentStatusAuthorityObservedAt(entry);
}
function isAgentStatusFresh(entry, now = Date.now(), staleAfterMs = AGENT_STATUS_STALE_AFTER_MS) {
  return entry.restoredUnconfirmed !== true && (entry.structuredHostOwned === true || now - agentStatusEvidenceObservedAt(entry) <= staleAfterMs);
}

// src/shared/agent-status/lifecycle/agent-turn-outcome.ts
var AGENT_JOURNAL_TURN_OUTCOMES = [
  "success",
  "failure",
  "cancellation",
  "superseded"
];
var AGENT_TURN_OUTCOMES = [
  ...AGENT_JOURNAL_TURN_OUTCOMES,
  "interruption",
  "unconfirmed"
];
function isAgentTurnOutcome(value) {
  return AGENT_TURN_OUTCOMES.some((known) => known === value);
}

// src/shared/agent-status/lifecycle/agent-main-agent-verdict.ts
function agentMainAgentVerdict(row) {
  if (row.mainAgent && row.mainAgent.state !== "done") {
    return null;
  }
  const outcome = row.mainAgent?.outcome;
  if (outcome !== void 0) {
    return isAgentTurnOutcome(outcome) ? outcome : null;
  }
  return row.state === "done" && row.interrupted === true ? "cancellation" : null;
}
function agentVerdictDisplayMark(row) {
  switch (agentMainAgentVerdict(row)) {
    case "failure":
    case "interruption":
      return "failed";
    case "cancellation":
    case "superseded":
      return row.state === "done" ? "interrupted" : null;
    case "unconfirmed":
      return row.state === "done" ? "unconfirmed" : null;
    case "success":
    case null:
      return null;
  }
}

// src/shared/agent-status/presentation/agent-row-decay-state.ts
function resolveDecayedAgentRowState(entry, hasLivePty) {
  return hasLivePty && entry.state !== "done" && entry.restoredUnconfirmed !== true ? "unverifiable" : "idle";
}

// mobile/src/worktree/agent-row-display.ts
function agentDotState(row, now) {
  const mark = agentVerdictDisplayMark(row);
  if (mark) {
    return mark;
  }
  if (row.state === "done") {
    return "done";
  }
  if (!isAgentStatusFresh(row, now)) {
    return resolveDecayedAgentRowState(row, row.hasLivePty === true);
  }
  if (row.state === "working") {
    return row.workingMode === "monitoring" ? "monitoring" : "working";
  }
  return row.state === "blocked" || row.state === "waiting" ? row.state : "idle";
}
function agentRowTimeAt(row) {
  if (row.state !== "done" && row.mainAgent && agentVerdictDisplayMark(row) === "failed") {
    return row.mainAgent.stateStartedAt;
  }
  return row.stateStartedAt;
}

// mobile/src/worktree/agent-row-lineage.ts
function buildAgentRowLineageTree(rows) {
  const byPaneKey = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!byPaneKey.has(row.paneKey)) {
      byPaneKey.set(row.paneKey, row);
    }
  }
  const childrenByParentPaneKey = /* @__PURE__ */ new Map();
  const childPaneKeys = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const parentPaneKey = row.parentPaneKey;
    if (!parentPaneKey || parentPaneKey === row.paneKey || !byPaneKey.has(parentPaneKey)) {
      continue;
    }
    childPaneKeys.add(row.paneKey);
    const siblings = childrenByParentPaneKey.get(parentPaneKey);
    if (siblings) {
      siblings.push(row);
    } else {
      childrenByParentPaneKey.set(parentPaneKey, [row]);
    }
  }
  const rootRows = rows.filter((row) => !childPaneKeys.has(row.paneKey));
  if (rootRows.length === 0 && rows.length > 0) {
    return { rootRows: [...rows], childrenByParentPaneKey: /* @__PURE__ */ new Map() };
  }
  return { rootRows, childrenByParentPaneKey };
}
function flattenAgentRowLineage(rows) {
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const ancestors = /* @__PURE__ */ new Set();
  const visit = (row, depth) => {
    if (ancestors.has(row.paneKey)) {
      return void 0;
    }
    seen.add(row.paneKey);
    const node = { row, depth, children: [] };
    out.push(node);
    ancestors.add(row.paneKey);
    for (const child of childrenByParentPaneKey.get(row.paneKey) ?? []) {
      const childNode = visit(child, depth + 1);
      if (childNode) {
        node.children.push(childNode);
      }
    }
    ancestors.delete(row.paneKey);
    return node;
  };
  for (const root of rootRows) {
    visit(root, 0);
  }
  for (const row of rows) {
    if (!seen.has(row.paneKey)) {
      seen.add(row.paneKey);
      out.push({ row, depth: 0, children: [] });
    }
  }
  return out;
}

// mobile/src/agents/agent-list-rows.ts
function agentStatusGroup(state) {
  const rank = AGENT_LIST_STATUS_RANK[state];
  if (rank < AGENT_LIST_STATUS_RANK.working) {
    return "needs-you";
  }
  if (rank <= AGENT_LIST_STATUS_RANK.monitoring) {
    return "working";
  }
  return state === "idle" ? "idle" : "done";
}
function listedAgentVerdict(agent) {
  return agent.activity?.listed === true ? agent.activity : void 0;
}
function agentListRowKey(hostId, paneKey) {
  return `${hostId}:${paneKey}`;
}
function hostAgents(input, hostId) {
  const info = input.worktreeInfo[hostId];
  const connected = input.hostStates[hostId] === "connected";
  const liveAgents = connected && !info?.catalogUnavailable ? info?.agents : void 0;
  const live = liveAgents !== void 0;
  const pending = (paneKey) => input.pendingActivity?.[agentListRowKey(hostId, paneKey)];
  const entries = (liveAgents ?? info?.lastSeenAgents ?? info?.agents ?? []).filter((entry) => {
    const change = pending(entry.agent.paneKey);
    return entry.agent.activity?.listed !== false && !(change && "cleared" in change);
  });
  const entryByPaneKey = new Map(entries.map((entry) => [entry.agent.paneKey, entry]));
  const toRow = (node, depth) => {
    const entry = entryByPaneKey.get(node.row.paneKey);
    if (!entry) {
      return null;
    }
    const { agent } = entry;
    const verdict = listedAgentVerdict(agent);
    const liveVerdict = live ? verdict : void 0;
    const change = pending(agent.paneKey);
    return {
      key: agentListRowKey(hostId, agent.paneKey),
      hostId,
      entry,
      title: verdict?.title.trim() || agentListTitle(agent),
      dotState: !live ? "idle" : verdict ? verdict.status : agentDotState(agent, input.now),
      timeAt: verdict?.sortAt ?? agentRowTimeAt(agent),
      stale: !live,
      offline: !connected,
      // Read state is the desktop's call; a host that sends none gets no bell and no actions.
      unread: liveVerdict ? change && "unread" in change ? change.unread : liveVerdict.unread : void 0,
      clearable: liveVerdict?.clearable === true,
      depth,
      workers: node.children.flatMap((child) => descendants(child, depth + 1))
    };
  };
  const descendants = (node, depth) => {
    const row = toRow(node, depth);
    return row ? [{ ...row, workers: [] }, ...row.workers] : [];
  };
  const lineage = entries.map(({ agent }) => {
    const verdict = listedAgentVerdict(agent);
    return verdict ? { ...agent, parentPaneKey: verdict.childOf ?? null } : agent;
  });
  const roots = flattenAgentRowLineage(lineage).filter((node) => node.depth === 0).map((node) => toRow(node, 0)).filter((row) => row !== null);
  return { hostId, roots, live, offline: !connected, seenAt: info?.countsProvenAt };
}
function everyRow(roots) {
  return roots.flatMap((row) => [row, ...row.workers]);
}
var asTopLevel = (row) => ({ ...row, depth: 0, workers: [] });
var newestFirst = (a, b) => b.timeAt - a.timeAt;
var byStatusThenRecent = (a, b) => AGENT_LIST_STATUS_RANK[a.dotState] - AGENT_LIST_STATUS_RANK[b.dotState] || newestFirst(a, b);
function rowNeedsYou(row) {
  return !row.stale && agentStatusGroup(row.dotState) === "needs-you";
}
function selectAgentsNeedingYou(input) {
  return input.hosts.flatMap((host) => everyRow(hostAgents(input, host.id).roots)).filter(rowNeedsYou).map(asTopLevel).sort(byStatusThenRecent);
}
function selectActiveAgents(input) {
  return input.hosts.flatMap((host) => everyRow(hostAgents(input, host.id).roots)).filter((row) => {
    const group = agentStatusGroup(row.dotState);
    return !row.stale && (group === "needs-you" || group === "working");
  }).map(asTopLevel).sort(byStatusThenRecent);
}
function summarizeAgentListHosts(input) {
  return input.hosts.map((host) => {
    const agents = hostAgents(input, host.id);
    const rows = everyRow(agents.roots);
    return {
      hostId: host.id,
      agents: rows.length,
      needsYou: rows.filter(rowNeedsYou).length,
      offline: agents.offline
    };
  });
}

// mobile/src/agents/agent-list-model.ts
function groupRows(rows, keyOf) {
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const draft = keyOf(row);
    const group = groups.get(draft.key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(draft.key, { ...draft, rows: [row] });
    }
  }
  return [...groups.values()];
}
function byUrgencyThenRecent(a, b) {
  const urgent = (group) => group.rows.some(rowNeedsYou) ? 0 : 1;
  const latest = (group) => Math.max(...group.rows.map((row) => row.timeAt));
  return urgent(a) - urgent(b) || latest(b) - latest(a);
}
var STATUS_SECTIONS = [
  "needs-you",
  "working",
  "done"
];
function buildAgentList(input, options) {
  const { view } = options;
  const hosts = input.hosts.filter((host) => options.hostFilter === null || host.id === options.hostFilter).map((host) => hostAgents(input, host.id));
  const anyLive = hosts.some((host) => host.live);
  const nameDesktop = input.hosts.length > 1 && options.hostFilter === null;
  const query = options.query.trim().toLowerCase();
  const shown = (row) => !view.unreadOnly || row.unread === true || row.unread === void 0 && !listedAgentVerdict(row.entry.agent) || row.workers.some((worker) => worker.unread);
  const topLevel = (host) => {
    if (query) {
      return everyRow(host.roots).filter((row) => agentListEntryMatches(row.entry, query)).map(asTopLevel).filter(shown);
    }
    if (!view.showWorkers) {
      return everyRow(host.roots).filter((row) => {
        const verdict = listedAgentVerdict(row.entry.agent);
        return verdict ? !verdict.foldedChild : row.depth === 0 || rowNeedsYou(row);
      }).map(asTopLevel).filter(shown);
    }
    const surfaced = host.roots.flatMap((root) => root.workers.filter(rowNeedsYou).map(asTopLevel));
    return [...host.roots, ...surfaced].filter(shown);
  };
  const section = (draft, kind2, footer, names, order = newestFirst) => ({
    ...draft,
    kind: kind2,
    rows: [...draft.rows].sort(order),
    footer,
    nameDesktop: names
  });
  if (view.groupBy === "desktop") {
    const sections2 = hosts.flatMap((host) => {
      const rows2 = topLevel(host);
      if (rows2.length === 0 && (host.live || query)) {
        return [];
      }
      return [
        {
          ...section(
            { key: host.hostId, hostId: host.hostId, rows: rows2 },
            "desktop",
            "workspace",
            false
          ),
          ...host.live ? {} : { lastSeen: { offline: host.offline, at: host.seenAt } }
        }
      ];
    });
    return { sections: sections2, anyLive };
  }
  if (view.groupBy === "status") {
    const live = hosts.filter((host) => host.live).flatMap(topLevel);
    const sections2 = STATUS_SECTIONS.map(
      (kind2) => section(
        { key: kind2, rows: live.filter((row) => agentStatusGroup(row.dotState) === kind2) },
        kind2,
        "workspace",
        nameDesktop,
        byStatusThenRecent
      )
    ).filter((entry) => entry.rows.length > 0);
    const idleRows = live.filter((row) => agentStatusGroup(row.dotState) === "idle");
    if (idleRows.length > 0) {
      const folded = [...idleRows].sort(newestFirst);
      const last = sections2.at(-1);
      if (last) {
        sections2[sections2.length - 1] = { ...last, idleRows: folded };
      } else {
        sections2.push({
          ...section({ key: "idle", rows: [] }, "idle", "workspace", nameDesktop),
          idleRows: folded
        });
      }
    }
    for (const host of hosts) {
      const rows2 = host.live ? [] : topLevel(host);
      if (rows2.length > 0) {
        sections2.push({
          ...section(
            { key: host.hostId, hostId: host.hostId, rows: rows2 },
            "desktop",
            "workspace",
            false
          ),
          lastSeen: { offline: host.offline, at: host.seenAt }
        });
      }
    }
    return { sections: sections2, anyLive };
  }
  const rows = hosts.flatMap(topLevel);
  const drafts = view.groupBy === "workspace" ? groupRows(rows, (row) => ({
    key: JSON.stringify([
      row.hostId,
      row.entry.executionHostId ?? "local",
      row.entry.workspaceIdentityKey ?? row.entry.worktreeId
    ]),
    title: row.entry.workspaceName,
    hostId: row.hostId
  })) : view.groupBy === "project" ? groupRows(rows, (row) => ({
    key: JSON.stringify([
      row.hostId,
      row.entry.executionHostId ?? "local",
      row.entry.repoId ?? row.entry.repo
    ]),
    title: row.entry.repo,
    hostId: row.hostId
  })) : groupRows(rows, (row) => {
    const label = formatAgentTypeLabel(row.entry.agent.agentType);
    return { key: label, title: label };
  });
  const kind = view.groupBy;
  const sections = drafts.sort(byUrgencyThenRecent).map(
    (draft) => kind === "agent" ? section(draft, kind, "workspace", nameDesktop) : section(draft, kind, kind === "workspace" ? "agent" : "workspace", false)
  );
  return { sections, anyLive };
}
function agentListRowsIn(sections) {
  const rows = /* @__PURE__ */ new Map();
  for (const section of sections) {
    for (const row of everyRow([...section.rows, ...section.idleRows ?? []])) {
      rows.set(row.key, row);
    }
  }
  return [...rows.values()];
}
