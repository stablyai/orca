var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
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
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// orca-connection-diagnostics-entry.ts
var orca_connection_diagnostics_entry_exports = {};
__export(orca_connection_diagnostics_entry_exports, {
  CONNECTION_DIAGNOSTICS_ENDPOINT: () => CONNECTION_DIAGNOSTICS_ENDPOINT,
  buildConnectionDiagnosticsReport: () => buildConnectionDiagnosticsReport,
  createRelayHostReachability: () => createRelayHostReachability,
  describeDesktopConnection: () => describeDesktopConnection,
  diagnoseConnection: () => diagnoseConnection,
  displayHostEndpoint: () => displayHostEndpoint,
  formatConnectionLogHistory: () => formatConnectionLogHistory,
  formatEndpoint: () => formatEndpoint,
  getReportableConnectionIncidentId: () => getReportableConnectionIncidentId,
  getTroubleshootCommonIssues: () => getTroubleshootCommonIssues,
  installRuntime: () => installRuntime,
  isTailscaleEndpoint: () => isTailscaleEndpoint,
  redactConnectionLogText: () => redactConnectionLogText,
  relayHostCloseReasonFrom: () => relayHostCloseReasonFrom,
  relayHostReachabilityForCloseCode: () => relayHostReachabilityForCloseCode,
  resolveHostEndpointEdit: () => resolveHostEndpointEdit,
  serializeConnectionDiagnosticsSubmission: () => serializeConnectionDiagnosticsSubmission
});
module.exports = __toCommonJS(orca_connection_diagnostics_entry_exports);

// orca:orca-diagnostic-runtime
var parseUrl;
var encodeText;
function installRuntime(url, encode) {
  parseUrl = url;
  encodeText = encode;
}
var URL = class {
  constructor(value) {
    return parseUrl(value);
  }
};
var TextEncoder = class {
  encode(value) {
    return encodeText(value);
  }
};

// src/shared/remote-runtime/remote-runtime-tailscale-hint.ts
var TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
var TAILSCALE_MAGIC_DNS_SUFFIX_RE = /(?:^|\.)ts\.net$/i;
var IPV4_LITERAL_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
var TAILSCALE_CGNAT_RE = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
var TAILSCALE_IPV6_RE = /^fd7a:115c:a1e0:/i;
var SAFE_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|[0-9a-f:]+)$/i;
function extractHost(endpoint) {
  let host;
  try {
    host = new URL(endpoint).hostname || null;
  } catch {
    host = endpoint.replace(/^[a-z]+:\/\//i, "").split(/[/:?#]/, 1)[0] || null;
  }
  if (!host) {
    return null;
  }
  return host.replace(/^\[|\]$/g, "").replace(/\.$/, "") || null;
}
function tailscaleHostOfEndpoint(endpoint) {
  const host = endpoint ? extractHost(endpoint) : null;
  if (!host || !SAFE_HOST_RE.test(host)) {
    return null;
  }
  return TAILSCALE_MAGIC_DNS_SUFFIX_RE.test(host) || IPV4_LITERAL_RE.test(host) && TAILSCALE_CGNAT_RE.test(host) || TAILSCALE_IPV6_RE.test(host) ? host : null;
}
function isTailscaleEndpoint(endpoint) {
  return tailscaleHostOfEndpoint(endpoint) !== null;
}
var OTHER_NETWORK_HINT = `If the server is on another network, connect both devices to Tailscale and pair using its Tailscale address (100.x or a *.ts.net name). See ${TAILSCALE_DOWNLOAD_URL}.`;

// src/shared/remote-runtime/relay/mobile-relay-close-codes.ts
var MOBILE_RELAY_CLOSE_CODE = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503
};

// mobile/src/transport/relay/relay-host-reachability.ts
var TRANSPORT_CLOSE_CODE = 1006;
function relayHostReachabilityForCloseCode(code) {
  switch (code) {
    case MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE:
      return "host-offline";
    case MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL:
      return "credential-refused";
    case TRANSPORT_CLOSE_CODE:
      return "unreachable";
    default:
      return "connecting";
  }
}

// mobile/src/diagnostics/connection-diagnostics-analysis.ts
function diagnoseConnection(args) {
  if (args.state === "connected") {
    return {
      likelyCause: `Connection is healthy${args.activePath ? ` via ${formatPath(args.activePath)}` : ""}.`,
      nextStep: "No action needed.",
      reportability: "none"
    };
  }
  const selected = selectDiagnosticFailure(args.entries);
  const failure = selected?.entry;
  const evidence = failure ? diagnosticEvidence(failure) : "";
  const diagnosis = diagnoseFailure(args, failure, evidence);
  if (!selected?.staleSince) {
    return diagnosis;
  }
  const boundary = selected.staleSince === "network-changed" ? "the last network change" : "the app last resumed";
  return {
    likelyCause: `Before ${boundary}: ${diagnosis.likelyCause}`,
    nextStep: diagnosis.nextStep,
    reportability: "none"
  };
}
function diagnoseFailure(args, failure, evidence) {
  if (/relay director resolve failed \(401\)/i.test(evidence)) {
    return {
      likelyCause: "Relay rejected the saved resume credential.",
      nextStep: "Try a direct connection; if Relay keeps returning 401, pair this device again.",
      reportability: "none"
    };
  }
  if (/relay director resolve failed \(503\)/i.test(evidence)) {
    const retryMs = parseRetryDelayMs(evidence);
    return {
      likelyCause: `Relay service was temporarily unavailable${retryMs == null ? "." : ` and asked Orca to retry in ${formatDelay(retryMs)}.`}`,
      nextStep: "Keep Orca open; recovery should retry automatically.",
      reportability: "none"
    };
  }
  const relayDial = relayDialFailure(failure);
  if (relayDial) {
    return relayDial;
  }
  if (failure?.code === "suspended-dial") {
    return {
      likelyCause: "Connection deadline delivery was delayed; the app may have been suspended.",
      nextStep: "Orca is re-dialing to check the connection. Keep the app open while it retries.",
      reportability: "none"
    };
  }
  if (/liveness-timeout|liveness timeout|connection health check failed/i.test(evidence)) {
    const relayLiveness = failure?.code === "liveness-timeout" && failure.path === "relay";
    const structuredDirectLiveness = failure?.code === "liveness-timeout" && (failure.path === "lan" || failure.path === "tailscale");
    const path = relayLiveness || !structuredDirectLiveness && args.activePath === "relay" ? "Relay" : "The connected host";
    return {
      likelyCause: `${path} stopped answering authenticated health checks.`,
      nextStep: "Orca closed the stale session and started recovery.",
      reportability: relayLiveness ? "orca-relay" : "none"
    };
  }
  if (/relay-session-failed|active relay session failed/i.test(evidence)) {
    return {
      likelyCause: "The active Relay session closed unexpectedly.",
      nextStep: "Orca started Relay recovery; the event history includes the cell close reason.",
      reportability: failure?.code === "relay-session-failed" && failure.path === "relay" ? "orca-relay" : "none"
    };
  }
  if (/authentication-rejected|unauthorized|pairing may be revoked/i.test(evidence)) {
    return {
      likelyCause: "The desktop rejected this device during authentication.",
      nextStep: "Confirm the device is still paired; pair it again if the rejection repeats.",
      reportability: "none"
    };
  }
  if (/connect-timeout|websocket connect timeout/i.test(evidence)) {
    return {
      likelyCause: isTailscaleEndpoint(args.endpoint) ? "The saved Tailscale endpoint did not answer before the connection timeout." : "The saved direct endpoint did not answer before the connection timeout.",
      nextStep: args.pendingPath === "relay" ? "Relay recovery is in progress; keep Orca open while it retries." : "Check the local/VPN network and confirm the desktop is awake.",
      reportability: "none"
    };
  }
  if (/handshake-timeout|handshake timeout/i.test(evidence)) {
    return {
      likelyCause: "The endpoint opened, but the encrypted Orca handshake did not finish.",
      nextStep: "Confirm the desktop is running a compatible Orca version and retry.",
      reportability: "none"
    };
  }
  if (args.pendingPath === "relay") {
    return {
      likelyCause: "Relay recovery is selected, but no more specific failure is recorded yet.",
      nextStep: "Keep this page open while the next recovery event is recorded.",
      reportability: "none"
    };
  }
  return {
    likelyCause: "No single failure cause can be determined from the recorded events.",
    nextStep: "Run diagnostics and copy the report again after the next connection attempt.",
    reportability: "none"
  };
}
function getReportableConnectionIncidentId(args) {
  const selected = selectDiagnosticFailure(args.entries);
  if (!selected || selected.staleSince) {
    return null;
  }
  return diagnoseFailure(args, selected.entry, diagnosticEvidence(selected.entry)).reportability === "orca-relay" ? selected.entry.id : null;
}
var RELAY_DIAL_ADVICE = {
  "host-offline": {
    likelyCause: (code) => `Relay answered, but the desktop is not connected to it (close code ${code}, host offline).`,
    nextStep: "Check the desktop is awake, Orca is running, and it is signed in to Orca Cloud."
  },
  "credential-refused": {
    likelyCause: (code) => `Relay refused this device\u2019s relay credential (close code ${code}).`,
    nextStep: "Re-pair this phone with the desktop."
  },
  unreachable: {
    likelyCause: (code) => `The phone could not reach the Relay cell (transport close ${code}).`,
    nextStep: "Check this phone\u2019s network connection; Relay recovery retries automatically."
  },
  connecting: {
    likelyCause: (code) => `Relay closed the dial with code ${code}; recovery re-resolves and retries.`,
    nextStep: "Keep Orca open while Relay recovery retries."
  }
};
function relayDialFailure(failure) {
  if (failure?.code !== "relay-dial-failed") {
    return null;
  }
  const code = failure.relayCloseCode;
  if (code == null) {
    return {
      likelyCause: "The Relay dial failed before the cell answered.",
      nextStep: RELAY_DIAL_ADVICE.unreachable.nextStep,
      reportability: "none"
    };
  }
  const advice = RELAY_DIAL_ADVICE[relayHostReachabilityForCloseCode(code)];
  return { likelyCause: advice.likelyCause(code), nextStep: advice.nextStep, reportability: "none" };
}
function selectDiagnosticFailure(entries) {
  const sessionStart = entries.findLastIndex(isSessionBoundary) + 1;
  const sinceSession = entries.slice(sessionStart);
  const boundaryIndex = sinceSession.findLastIndex(isResumeBoundary);
  const current = newestFailure(sinceSession.slice(boundaryIndex + 1));
  if (current) {
    return { entry: current, staleSince: null };
  }
  const stale = newestFailure(sinceSession.slice(0, boundaryIndex + 1));
  const boundary = sinceSession[boundaryIndex]?.code;
  return stale && isResumeBoundaryCode(boundary) ? { entry: stale, staleSince: boundary } : void 0;
}
function newestFailure(entries) {
  const newestFirst = entries.toReversed().filter(isDiagnosticFailure);
  return newestFirst.find((entry) => entry.path === "relay") ?? newestFirst[0];
}
function isSessionBoundary(entry) {
  return entry.code === "client-session-started" || entry.code === "relay-connected" || entry.code === "direct-connected" || entry.message === "Authenticated";
}
function isResumeBoundaryCode(code) {
  return code === "app-resumed" || code === "network-changed";
}
function isResumeBoundary(entry) {
  return isResumeBoundaryCode(entry.code);
}
function diagnosticEvidence(entry) {
  return `${entry.code ?? ""} ${entry.message} ${entry.detail ?? ""}`;
}
function isDiagnosticFailure(entry) {
  if (entry.code === "native-render-failed") {
    return false;
  }
  return /suspended-dial|relay director resolve failed \((?:401|503)\)|liveness-timeout|liveness timeout|connection health check failed|relay-dial-failed|relay dial failed|relay-session-failed|active relay session failed|authentication-rejected|unauthorized|pairing may be revoked|connect-timeout|websocket connect timeout|handshake-timeout|handshake timeout/i.test(
    diagnosticEvidence(entry)
  );
}
function parseRetryDelayMs(evidence) {
  const match = /retry(?:-|\s)?after(?:=|\s)(\d+)ms/i.exec(evidence);
  return match ? Number(match[1]) : null;
}
function formatDelay(ms) {
  return ms < 6e4 ? `${Math.round(ms / 1e3)}s` : `${Math.round(ms / 6e4)}m`;
}
function formatPath(path) {
  if (path === "relay") {
    return "Relay";
  }
  return path === "tailscale" ? "Tailscale/direct" : "LAN/direct";
}

// src/shared/utf8-byte-limits.ts
function readUtf8CodePointAt(text, index) {
  const leadUnit = text.charCodeAt(index);
  if (leadUnit < 55296 || leadUnit > 56319 || index + 1 >= text.length) {
    return leadUnit;
  }
  const trailUnit = text.charCodeAt(index + 1);
  if (trailUnit < 56320 || trailUnit > 57343) {
    return leadUnit;
  }
  return (leadUnit - 55296) * 1024 + (trailUnit - 56320) + 65536;
}
var MAX_UTF8_SCRATCH_BYTES = 1024 * 1024;
var utf8Encoder = new TextEncoder();
var utf8Scratch = new Uint8Array(0);
function clampUtf8TextPrefix(text, maxBytes) {
  if (!text || maxBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const codePoint = readUtf8CodePointAt(text, end);
    const codePointBytes = getUtf8ByteLengthForCodePoint(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    bytes += codePointBytes;
    end += codePoint > 65535 ? 2 : 1;
  }
  return end === text.length ? text : text.slice(0, end);
}
function getUtf8ByteLengthForCodePoint(codePoint) {
  if (codePoint <= 127) {
    return 1;
  }
  if (codePoint <= 2047) {
    return 2;
  }
  if (codePoint <= 65535) {
    return 3;
  }
  return 4;
}

// mobile/src/host-descriptors/host-app-version.ts
var MAX_VERSION_LENGTH = 64;
function normalizeHostAppVersion(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_VERSION_LENGTH || normalized.includes("\n") || normalized.includes("\r")) {
    return null;
  }
  return normalized;
}

// mobile/src/diagnostics/host-reachability.ts
function formatEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.host;
  } catch {
    return "invalid endpoint";
  }
}

// mobile/src/diagnostics/connection-log-redaction.ts
var SECRET_JSON_ASSIGNMENT = /(["'])(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)\1(\s*:\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\4)[^\\\r\n])*\4/gi;
var SECRET_QUOTED_VALUE_ASSIGNMENT = /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\3)[^\\\r\n])*\3/gi;
var SECRET_UNTERMINATED_JSON_ASSIGNMENT = /(["'])(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)\1(\s*:\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/gi;
var SECRET_UNTERMINATED_QUOTED_VALUE_ASSIGNMENT = /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\3)[^\\\r\n])*(?=\r?\n|$)/gi;
var SECRET_ASSIGNMENT = /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(?:Bearer\s+)?([^\s;,}"']+)/gi;
var SECRET_QUERY = /([?&](?:token|credential|resumeToken|deviceToken)=)[^&#\s]+/gi;
var URL_USERINFO = /((?:wss?|https?):\/\/)[^\s/?#]*@/gi;
function redactConnectionLogText(value) {
  return value.replace(
    SECRET_JSON_ASSIGNMENT,
    (_match, keyQuote, label, separator, valueQuote) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
  ).replace(
    SECRET_QUOTED_VALUE_ASSIGNMENT,
    (_match, label, separator, valueQuote) => `${label}${separator}${valueQuote}[redacted]${valueQuote}`
  ).replace(
    SECRET_UNTERMINATED_JSON_ASSIGNMENT,
    (_match, keyQuote, label, separator, valueQuote) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}[redacted]`
  ).replace(
    SECRET_UNTERMINATED_QUOTED_VALUE_ASSIGNMENT,
    (_match, label, separator, valueQuote) => `${label}${separator}${valueQuote}[redacted]`
  ).replace(SECRET_ASSIGNMENT, (_match, label, separator) => {
    return `${label}${separator}[redacted]`;
  }).replace(SECRET_QUERY, "$1[redacted]").replace(URL_USERINFO, "$1[redacted]@");
}
function redactConnectionLogEntry(entry) {
  return {
    ...entry,
    message: redactConnectionLogText(entry.message),
    ...entry.detail ? { detail: redactConnectionLogText(entry.detail) } : {}
  };
}

// mobile/src/diagnostics/connection-diagnostics-report.ts
var MAX_EVENT_LINE_BYTES = 2 * 1024;
var EVENT_TRUNCATION_MARKER = " \u2026 [truncated]";
function buildConnectionDiagnosticsReport(args) {
  const now = args.nowMs ?? Date.now();
  const entries = args.entries.map(redactConnectionLogEntry);
  const diagnosis = diagnoseConnection({
    endpoint: args.endpoint,
    state: args.state,
    activePath: args.activePath,
    pendingPath: args.pendingPath,
    entries
  });
  const lines = [];
  lines.push("Orca Mobile connection diagnostics");
  lines.push(`Generated: ${new Date(now).toISOString()}`);
  lines.push(`App: Orca Mobile ${args.appVersion} \xB7 ${args.platform}`);
  lines.push(`Bridge protocol: ${args.bridgeProtocolVersion}`);
  const desktopAppVersion = args.state === "connected" ? normalizeHostAppVersion(args.desktopAppVersion) : null;
  lines.push(
    `Host Orca version: ${desktopAppVersion ?? (args.state === "connected" ? "unknown" : "unknown (not currently connected)")}`
  );
  lines.push(`Host: ${redactConnectionLogText(args.hostName)}`);
  lines.push(
    `Endpoint: ${formatEndpoint(args.endpoint)}${isTailscaleEndpoint(args.endpoint) ? " (Tailscale)" : ""}`
  );
  lines.push(`State: ${args.state} (reconnect attempts: ${args.reconnectAttempts})`);
  if (args.activePath) {
    lines.push(
      `Path: active=${args.activePath}${args.pendingPath ? `; recovery=${args.pendingPath}` : ""}`
    );
  }
  lines.push(
    args.lastConnectedAt == null ? "Last connected: never this session" : `Last connected: ${new Date(args.lastConnectedAt).toISOString()} (${formatAgo(now - args.lastConnectedAt)} ago)`
  );
  lines.push("");
  lines.push(`Likely cause: ${diagnosis.likelyCause}`);
  lines.push(`Next step: ${diagnosis.nextStep}`);
  lines.push("");
  lines.push(formatConnectionLogHistory(entries));
  return lines.join("\n");
}
function formatConnectionLogHistory(entries) {
  const lines = [];
  if (entries.length === 0) {
    lines.push("No connection events recorded.");
  } else {
    lines.push(`Recent connection history (${entries.length} events, oldest first):`);
    for (const rawEntry of entries) {
      const entry = redactConnectionLogEntry(rawEntry);
      const detail = entry.detail ? ` \u2014 ${entry.detail}` : "";
      const evidence = [entry.code, entry.path].filter(Boolean).join(" \xB7 ");
      lines.push(
        truncateUtf8WithMarker(
          `${new Date(entry.ts).toISOString()} [${entry.level}]${evidence ? ` [${evidence}]` : ""} ${entry.message}${detail}`,
          MAX_EVENT_LINE_BYTES,
          EVENT_TRUNCATION_MARKER
        )
      );
    }
  }
  return lines.join("\n");
}
function truncateUtf8WithMarker(value, maxBytes, marker) {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) {
    return value;
  }
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  return `${clampUtf8TextPrefix(value, maxBytes - markerBytes)}${marker}`;
}
function formatAgo(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// mobile/src/diagnostics/connection-diagnostics-submission.ts
var CONNECTION_DIAGNOSTICS_ENDPOINT = "https://orca.dev/v1/feedback";
var MAX_SUBMISSION_BYTES = 64 * 1024;
function serializeConnectionDiagnosticsSubmission(submission) {
  return JSON.stringify({
    feedback: boundConnectionDiagnosticsReport(submission.report),
    submissionType: "connection_diagnostics",
    githubLogin: null,
    githubEmail: null,
    appVersion: submission.appVersion,
    platform: `mobile-${submission.platform}`,
    osRelease: "unknown",
    arch: "unknown"
  });
}
function boundConnectionDiagnosticsReport(report, maxBytes = MAX_SUBMISSION_BYTES) {
  if (utf8Bytes(report) <= maxBytes) {
    return report;
  }
  const lines = report.split("\n");
  const historyIndex = lines.findIndex((line) => line.startsWith("Recent connection history ("));
  if (historyIndex === -1) {
    return clampUtf8TextPrefix(report, maxBytes);
  }
  const header = lines.slice(0, historyIndex);
  const events = lines.slice(historyIndex + 1);
  let kept = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const candidateEvents = [events[index], ...kept];
    const candidate = formatBoundedReport(header, candidateEvents, events.length);
    if (utf8Bytes(candidate) > maxBytes) {
      break;
    }
    kept = candidateEvents;
  }
  if (kept.length === 0 && events.length > 0) {
    return formatReportWithTruncatedNewestEvent(header, events, maxBytes);
  }
  return clampUtf8TextPrefix(formatBoundedReport(header, kept, events.length), maxBytes);
}
function formatReportWithTruncatedNewestEvent(header, events, maxBytes) {
  const history = `Recent connection history (1 newest event; ${events.length - 1} older omitted):`;
  const prefix = [...header, history].join("\n") + "\n";
  const availableBytes = maxBytes - utf8Bytes(prefix);
  if (availableBytes <= 0) {
    return clampUtf8TextPrefix(prefix, maxBytes);
  }
  const marker = " \u2026 [truncated]";
  const markerBytes = utf8Bytes(marker);
  if (availableBytes <= markerBytes) {
    return clampUtf8TextPrefix(prefix, maxBytes);
  }
  return `${prefix}${clampUtf8TextPrefix(events.at(-1), availableBytes - markerBytes)}${marker}`;
}
function formatBoundedReport(header, events, totalEvents) {
  const omitted = totalEvents - events.length;
  return [
    ...header,
    `Recent connection history (${events.length} newest events; ${omitted} older omitted):`,
    ...events
  ].join("\n");
}
function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

// orca:orca-diagnostic-translation
var translator;
function withTranslation(next, describe) {
  const previous = translator;
  translator = next;
  try {
    return describe();
  } finally {
    translator = previous;
  }
}
function translate(key, fallback, values) {
  const text = translator?.(key, fallback) ?? fallback;
  return values ? text.replace(/{{(\w+)}}/g, (token, name) => values[name] ?? token) : text;
}

// mobile/src/transport/hosts/host-endpoint-copy.ts
var hostEndpointCopy = {
  addressRequired: () => translate("connection.hostEndpoint.addressRequired", "Enter a host address."),
  invalidPort: () => translate("connection.hostEndpoint.invalidPort", "Port must be 1\u201365535."),
  invalidScheme: () => translate("connection.hostEndpoint.invalidScheme", "Use ws:// or wss:// (or host:port)."),
  invalidAddress: () => translate("connection.hostEndpoint.invalidAddress", "Not a valid address."),
  pathOrQueryNotAllowed: () => translate(
    "connection.hostEndpoint.pathOrQueryNotAllowed",
    "Host must not include a path or query."
  ),
  invalidHostname: () => translate("connection.hostEndpoint.invalidHostname", "Not a valid hostname."),
  hostnameRequired: () => translate("connection.hostEndpoint.hostnameRequired", "Missing hostname.")
};

// mobile/src/transport/hosts/host-endpoint.ts
var DEFAULT_PORT = "6768";
var NUMERIC_IPV4_CANDIDATE = /^(?:0[xX][0-9a-fA-F]+|\d+)(?:\.(?:0[xX][0-9a-fA-F]+|\d+))*$/;
function displayHostEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const host = formatHostForUrl(unwrapHostname(url.hostname));
    const port = resolveWebsocketUrlPort(endpoint, url);
    if (port.kind === "invalid") {
      return endpoint;
    }
    return port.kind === "valid" ? `${host}:${port.port}` : host;
  } catch {
    return endpoint;
  }
}
function unwrapHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
function extractExplicitPortFromWebsocketUrl(input) {
  const withoutScheme = input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  if (withoutScheme.startsWith("[")) {
    const close = withoutScheme.indexOf("]");
    if (close <= 1) {
      return null;
    }
    const rest = withoutScheme.slice(close + 1);
    const match2 = /^:(\d+)(?=[/?#]|$)/.exec(rest);
    return match2?.[1] ?? null;
  }
  const end = withoutScheme.search(/[/?#]/);
  const authority = end === -1 ? withoutScheme : withoutScheme.slice(0, end);
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const match = /:(\d+)$/.exec(hostPort);
  return match?.[1] ?? null;
}
function resolveWebsocketUrlPort(input, url) {
  const explicit = extractExplicitPortFromWebsocketUrl(input);
  if (explicit !== null && !isValidPort(explicit)) {
    return { kind: "invalid" };
  }
  if (url?.port) {
    return isValidPort(url.port) ? { kind: "valid", port: url.port } : { kind: "invalid" };
  }
  if (explicit !== null) {
    return { kind: "valid", port: explicit };
  }
  return { kind: "missing" };
}
function endpointPort(endpoint) {
  try {
    const url = new URL(endpoint);
    const port = resolveWebsocketUrlPort(endpoint, url);
    return port.kind === "valid" ? port.port : void 0;
  } catch {
    return void 0;
  }
}
function endpointScheme(endpoint) {
  try {
    const protocol = new URL(endpoint).protocol.replace(":", "");
    return protocol === "wss" ? "wss" : "ws";
  } catch {
    return "ws";
  }
}
function normalizeHostEndpoint(input, options) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: hostEndpointCopy.addressRequired() };
  }
  const fallbackPort = resolveFallbackPort(options?.fallbackPort);
  const fallbackScheme = options?.fallbackScheme === "wss" ? "wss" : "ws";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return normalizeSchemeUrl(trimmed, fallbackPort);
  }
  return normalizeHostPort(trimmed, fallbackPort, fallbackScheme);
}
function resolveFallbackPort(value) {
  if (value == null) {
    return DEFAULT_PORT;
  }
  const asString = String(value).trim();
  if (!asString || !isValidPort(asString)) {
    return DEFAULT_PORT;
  }
  return asString;
}
function normalizeSchemeUrl(input, fallbackPort) {
  const explicitPort = resolveWebsocketUrlPort(input);
  if (explicitPort.kind === "invalid") {
    return { ok: false, error: hostEndpointCopy.invalidPort() };
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input)?.[1]?.toLowerCase();
  if (scheme !== "ws" && scheme !== "wss") {
    return { ok: false, error: hostEndpointCopy.invalidScheme() };
  }
  const rawAuthority = parseRawSchemeAuthority(input);
  if (rawAuthority.hasUserInfo) {
    return { ok: false, error: hostEndpointCopy.invalidAddress() };
  }
  if (rawAuthority.hasPathOrQuery) {
    return { ok: false, error: hostEndpointCopy.pathOrQueryNotAllowed() };
  }
  if (rawAuthority.hostname && validateNumericIpv4Candidate(normalizeRawNumericIpv4Candidate(rawAuthority.hostname))) {
    return { ok: false, error: hostEndpointCopy.invalidHostname() };
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: hostEndpointCopy.invalidAddress() };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, error: hostEndpointCopy.invalidScheme() };
  }
  if (!url.hostname) {
    return { ok: false, error: hostEndpointCopy.hostnameRequired() };
  }
  if (url.username || url.password) {
    return { ok: false, error: hostEndpointCopy.invalidAddress() };
  }
  if (url.pathname && url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, error: hostEndpointCopy.pathOrQueryNotAllowed() };
  }
  const hostname = unwrapHostname(url.hostname);
  if (rawAuthority.hostname && isCanonicalIpv4(hostname) && rawAuthority.hostname !== hostname) {
    return { ok: false, error: hostEndpointCopy.invalidHostname() };
  }
  const hostError = validateHostname(hostname);
  if (hostError) {
    return { ok: false, error: hostError };
  }
  const resolvedPort = resolveWebsocketUrlPort(input, url);
  if (resolvedPort.kind === "invalid") {
    return { ok: false, error: hostEndpointCopy.invalidPort() };
  }
  const port = resolvedPort.kind === "valid" ? resolvedPort.port : fallbackPort;
  return { ok: true, endpoint: `${url.protocol}//${formatHostForUrl(hostname)}:${port}` };
}
function parseRawSchemeAuthority(input) {
  const schemeEnd = input.indexOf("://");
  const remainder = input.slice(schemeEnd + 3);
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  const suffix = authorityEnd === -1 ? "" : remainder.slice(authorityEnd);
  const hasUserInfo = authority.includes("@");
  const hostPort = hasUserInfo ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  if (!hostPort) {
    return { hostname: null, hasUserInfo, hasPathOrQuery: suffix !== "" && suffix !== "/" };
  }
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    return {
      hostname: close > 1 ? hostPort.slice(1, close) : null,
      hasUserInfo,
      hasPathOrQuery: suffix !== "" && suffix !== "/"
    };
  }
  const lastColon = hostPort.lastIndexOf(":");
  return {
    hostname: lastColon === -1 ? hostPort : hostPort.slice(0, lastColon),
    hasUserInfo,
    hasPathOrQuery: suffix !== "" && suffix !== "/"
  };
}
function normalizeHostPort(input, fallbackPort, fallbackScheme) {
  let host;
  let port;
  if (input.startsWith("[")) {
    const close = input.indexOf("]");
    if (close <= 1) {
      return { ok: false, error: hostEndpointCopy.invalidAddress() };
    }
    host = input.slice(1, close);
    const rest = input.slice(close + 1);
    if (rest.startsWith(":")) {
      port = rest.slice(1);
    } else if (rest.length > 0) {
      return { ok: false, error: hostEndpointCopy.invalidAddress() };
    }
  } else {
    const firstColon = input.indexOf(":");
    const lastColon = input.lastIndexOf(":");
    if (firstColon !== -1 && firstColon === lastColon) {
      host = input.slice(0, firstColon);
      port = input.slice(firstColon + 1);
    } else {
      host = input;
    }
  }
  host = host.trim();
  if (!host) {
    return { ok: false, error: hostEndpointCopy.hostnameRequired() };
  }
  const hostError = validateHostname(host);
  if (hostError) {
    return { ok: false, error: hostError };
  }
  if (port !== void 0) {
    port = port.trim();
    if (!isValidPort(port)) {
      return { ok: false, error: hostEndpointCopy.invalidPort() };
    }
  }
  const finalPort = port ?? fallbackPort;
  return { ok: true, endpoint: `${fallbackScheme}://${formatHostForUrl(host)}:${finalPort}` };
}
function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
function validateHostname(host) {
  if (!host) {
    return hostEndpointCopy.hostnameRequired();
  }
  if (/[\s/?#@[\]]/.test(host)) {
    return hostEndpointCopy.invalidHostname();
  }
  const numericIpv4Error = validateNumericIpv4Candidate(host);
  if (numericIpv4Error) {
    return numericIpv4Error;
  }
  if (host.includes(":")) {
    if (!/^[0-9a-fA-F:]+$/.test(host)) {
      return hostEndpointCopy.invalidHostname();
    }
    try {
      new URL(`ws://[${host}]:${DEFAULT_PORT}`);
    } catch {
      return hostEndpointCopy.invalidHostname();
    }
    return null;
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    host
  )) {
    return hostEndpointCopy.invalidHostname();
  }
  return null;
}
function validateNumericIpv4Candidate(host) {
  if (!NUMERIC_IPV4_CANDIDATE.test(host)) {
    return null;
  }
  if (!isCanonicalIpv4(host)) {
    return hostEndpointCopy.invalidHostname();
  }
  return null;
}
function normalizeRawNumericIpv4Candidate(host) {
  let decoded = host;
  try {
    decoded = decodeURIComponent(host);
  } catch {
  }
  return decoded.endsWith(".") ? decoded.slice(0, -1) : decoded;
}
function isCanonicalIpv4(host) {
  const octets = host.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}
function isValidPort(port) {
  if (!/^\d+$/.test(port)) {
    return false;
  }
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

// mobile/src/transport/hosts/host-endpoint-edit.ts
function resolveHostEndpointEdit(storedEndpoint, input) {
  const displayedEndpoint = displayHostEndpoint(storedEndpoint);
  if (input.trim() === displayedEndpoint) {
    return { kind: "unchanged", endpoint: storedEndpoint };
  }
  const fallbackScheme = endpointScheme(storedEndpoint);
  const fallbackPort = /^wss:\/\//i.test(input.trim()) ? "443" : endpointPort(storedEndpoint) ?? (fallbackScheme === "wss" ? "443" : void 0);
  const options = { fallbackPort, fallbackScheme };
  const normalizedInput = normalizeHostEndpoint(input, options);
  if (!normalizedInput.ok) {
    return { kind: "invalid", error: normalizedInput.error };
  }
  const normalizedDisplay = normalizeHostEndpoint(displayedEndpoint, options);
  if (sameEndpointAuthority(normalizedInput.endpoint, storedEndpoint) || normalizedDisplay.ok && sameEndpointAuthority(normalizedInput.endpoint, normalizedDisplay.endpoint)) {
    return { kind: "unchanged", endpoint: storedEndpoint };
  }
  return {
    kind: "changed",
    endpoint: normalizedInput.endpoint + endpointRouteSuffix(storedEndpoint)
  };
}
function sameEndpointAuthority(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
function endpointRouteSuffix(endpoint) {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(.*)$/.exec(endpoint);
  return match?.[1] ?? "";
}

// src/shared/relay-host-close-reason.ts
var RELAY_HOST_CLOSE_REASON = {
  // The desktop lost its Orca Cloud session (cleared, or refused with 401).
  SIGNED_OUT: "signed-out"
};
var REASONS = Object.values(RELAY_HOST_CLOSE_REASON);
function relayHostCloseReasonFrom(value) {
  const text = typeof value === "string" ? value : value?.toString() ?? "";
  return REASONS.includes(text) ? text : null;
}

// mobile/src/transport/connection/connection-health.ts
var WARNING_ATTEMPTS = 3;
var UNREACHABLE_ATTEMPTS = 12;
var STALE_SINCE_LAST_CONNECT_MS = 6e4;
function relayHostCopy() {
  return {
    "signed-out": {
      kind: "unreachable",
      label: (host) => translate("connection.connectionHealth.signInRequired", "Sign-in required on {{host}}", {
        host
      }),
      detail: translate(
        "connection.connectionHealth.signInDetail",
        "Sign in to Orca on your desktop to reconnect"
      )
    },
    "host-offline": {
      kind: "unreachable",
      label: (host) => translate("connection.connectionHealth.hostOffline", "{{host}} is offline", { host }),
      detail: translate(
        "connection.connectionHealth.hostOfflineDetail",
        "Check it's awake, Orca is running, and you're signed in"
      )
    },
    // Re-pairing repairs refused credentials even when direct rotation is unavailable.
    "credential-refused": {
      kind: "unreachable",
      label: (host) => translate(
        "connection.connectionHealth.relayAccessExpired",
        "Relay access expired for {{host}}",
        {
          host
        }
      ),
      detail: translate("connection.connectionHealth.rePairDetail", "Re-pair with your desktop")
    },
    // Cell reachability failure says nothing about desktop health, so keep it amber.
    unreachable: {
      kind: "warning",
      label: () => translate("connection.connectionHealth.relayUnreachable", "Can't reach Relay"),
      detail: translate("connection.connectionHealth.checkConnection", "Check your connection")
    }
  };
}
function classifyConnection(args) {
  const { state, reconnectAttempts, lastConnectedAt } = args;
  const now = args.nowMs ?? Date.now();
  const hint = isTailscaleEndpoint(args.endpoint) ? translate("connection.connectionHealth.tailscaleHint", "check Tailscale") : void 0;
  const host = args.hostName?.trim() || translate("connection.connectionHealth.hostFallback", "Host");
  const staleReason = lastConnectedAt == null ? "never-connected" : "stale";
  if (state === "auth-failed" || args.pairingRejected && state !== "connected") {
    return {
      kind: "auth-failed",
      label: translate(
        "connection.connectionHealth.pairingInvalid",
        "Pairing invalid \u2014 re-pair with your desktop"
      )
    };
  }
  if (state === "connected") {
    return {
      kind: "normal",
      label: translate("connection.connectionHealth.connected", "Connected")
    };
  }
  const reachability = args.relayHostReachability ?? "connecting";
  if (reachability !== "connecting") {
    const copy = relayHostCopy()[reachability];
    return copy.kind === "warning" ? { kind: "warning", label: copy.label(host), detail: copy.detail } : { kind: "unreachable", label: copy.label(host), reason: staleReason, detail: copy.detail };
  }
  if (args.pendingPath === "relay" && (state !== "disconnected" || reconnectAttempts > 0)) {
    if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
      if (lastConnectedAt == null) {
        return {
          kind: "unreachable",
          label: translate(
            "connection.connectionHealth.relayConnectFailed",
            "Can't connect via Relay"
          ),
          reason: "never-connected"
        };
      }
      if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
        return {
          kind: "unreachable",
          label: translate(
            "connection.connectionHealth.relayConnectFailed",
            "Can't connect via Relay"
          ),
          reason: "stale"
        };
      }
    }
    return {
      kind: "normal",
      label: translate("connection.connectionHealth.connectingViaRelay", "Connecting via Relay\u2026"),
      dialing: true
    };
  }
  if (state === "disconnected") {
    return {
      kind: "normal",
      label: translate("connection.connectionHealth.disconnected", "Disconnected")
    };
  }
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: "unreachable",
        label: translate("connection.connectionHealth.desktopUnreachable", "Can't reach desktop"),
        reason: "never-connected",
        hint
      };
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: "unreachable",
        label: translate("connection.connectionHealth.desktopUnreachable", "Can't reach desktop"),
        reason: "stale",
        hint
      };
    }
  }
  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return {
      kind: "warning",
      label: translate("connection.connectionHealth.connectFailed", "Can't connect"),
      hint
    };
  }
  return {
    kind: "normal",
    label: state === "reconnecting" ? translate("connection.connectionHealth.reconnecting", "Reconnecting\u2026") : translate("connection.connectionHealth.connecting", "Connecting\u2026"),
    dialing: true
  };
}
function isConnectionOutage(verdict) {
  return verdict.kind === "warning" || verdict.kind === "unreachable";
}
function verdictDisplayLabel(verdict) {
  if (isConnectionOutage(verdict) && verdict.hint) {
    return translate("connection.connectionHealth.labelWithHint", "{{label}} \u2014 {{hint}}", {
      label: verdict.label,
      hint: verdict.hint
    });
  }
  return verdict.label;
}

// mobile/src/transport/relay/relay-host-reachability-latch.ts
var RELAY_HOST_REACHABILITY_STREAK = 2;
var RelayHostReachabilityLatch = class {
  constructor() {
    __publicField(this, "candidate", "connecting");
    __publicField(this, "streak", 0);
    __publicField(this, "reported", "connecting");
    __publicField(this, "reporter", null);
  }
  current() {
    return this.reported;
  }
  reportTo(reporter) {
    this.reporter = reporter;
    reporter(this.reported);
  }
  record(next) {
    if (this.reported === "signed-out") {
      return;
    }
    if (next === "connecting") {
      this.streak = 0;
      return;
    }
    this.streak = next === this.candidate ? this.streak + 1 : 1;
    this.candidate = next;
    if (this.streak >= RELAY_HOST_REACHABILITY_STREAK) {
      this.publish(next);
    }
  }
  // The cell named the reason outright, so there is no streak to earn.
  assert(reachability) {
    this.candidate = reachability;
    this.streak = 0;
    this.publish(reachability);
  }
  clear() {
    this.candidate = "connecting";
    this.streak = 0;
    this.publish("connecting");
  }
  // Publish unconditionally; LogicalClientConnectionPath.update owns deduplication.
  publish(reachability) {
    this.reported = reachability;
    this.reporter?.(reachability);
  }
};

// mobile/src/diagnostics/troubleshoot-common-issues.ts
function troubleshootCommonIssues(t, endpoints = []) {
  const ports = new Set(
    endpoints.map((endpoint) => {
      const port = endpointPort(endpoint);
      if (port) {
        return port;
      }
      try {
        const url = new URL(endpoint);
        if (url.protocol === "wss:") {
          return "443";
        }
        if (url.protocol === "ws:") {
          return "80";
        }
      } catch {
      }
      return "6768";
    })
  );
  if (ports.size === 0) {
    ports.add("6768");
  }
  return [
    {
      id: "notifications",
      kind: "notifications",
      title: t("diagnostics.troubleshootCommonIssues.notificationsTitle", "Push Notifications"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.allowNotifications",
          "Check that system settings allow Orca notifications and that Focus or Do Not Disturb is off."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.notificationNetwork",
          "Try cellular or another Wi-Fi network. If alerts arrive after switching, your network may be delaying delivery."
        )
      ]
    },
    {
      id: "wifi",
      kind: "wifi",
      title: t("diagnostics.troubleshootCommonIssues.wifiTitle", "Different WiFi Networks"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.sameNetwork",
          "Both devices must be on the same LAN (unless connected through Tailscale)."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.sameSubnet",
          "Ethernet and WiFi must share the same subnet."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.reconnectWifi",
          "Try reconnecting WiFi on both devices."
        )
      ]
    },
    ...Array.from(ports, (port) => ({
      id: `firewall-${port}`,
      kind: "firewall",
      title: t(
        "diagnostics.troubleshootCommonIssues.firewallTitle",
        "Firewall Blocking Port {{port}}",
        {
          port
        }
      ),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.macosFirewall",
          "macOS: System Settings \u2192 Network \u2192 Firewall \u2014 allow Orca."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.windowsFirewall",
          "Windows: Defender Firewall \u2192 Allow app \u2014 enable Orca for Private networks."
        ),
        t("diagnostics.troubleshootCommonIssues.linuxFirewall", "Linux: sudo ufw allow {{port}}", {
          port
        }),
        t(
          "diagnostics.troubleshootCommonIssues.restrictedNetwork",
          "Corporate/school networks may block P2P \u2014 try a personal hotspot."
        )
      ]
    })),
    {
      id: "desktop",
      kind: "desktop",
      title: t("diagnostics.troubleshootCommonIssues.desktopTitle", "Desktop App Not Running"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.openDesktop",
          "Orca must be open on your desktop to accept connections."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.restartDesktop",
          "Try restarting Orca \u2014 the companion server starts on launch."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.pairAfterUpdate",
          "After an update, you may need to re-pair via QR code."
        )
      ]
    },
    {
      id: "timeout",
      kind: "timeout",
      title: t("diagnostics.troubleshootCommonIssues.timeoutTitle", "Connection Timeout"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.wifiSignal",
          "Check WiFi signal strength on your phone."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.retryHost",
          "Go back to the host list and tap your host to retry."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.restartBothApps",
          "Restart both apps if timeouts persist."
        )
      ]
    },
    {
      id: "tailscale",
      kind: "tailscale",
      title: t("diagnostics.troubleshootCommonIssues.tailscaleTitle", "Tailscale Host Unreachable"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.keepTailscaleOn",
          "Host addresses like 100.x.x.x or *.ts.net connect through Tailscale \u2014 keep it ON."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.restartTailscale",
          "iOS/Android can silently wedge the tunnel: toggle Tailscale off and back on in the Tailscale app."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.checkTailnet",
          "Check the desktop is awake and shows as connected in your tailnet."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.updateTailscale",
          "Update the Tailscale app \u2014 recent releases fix reconnect bugs."
        )
      ]
    },
    {
      id: "vpn",
      kind: "vpn",
      title: t("diagnostics.troubleshootCommonIssues.vpnTitle", "Other VPN Interference"),
      steps: [
        t(
          "diagnostics.troubleshootCommonIssues.vpnRouting",
          "Non-Tailscale VPNs can route local traffic through a remote server."
        ),
        t(
          "diagnostics.troubleshootCommonIssues.disableVpn",
          'Disable that VPN or enable split tunneling / "Allow LAN".'
        )
      ]
    }
  ];
}

// orca-connection-diagnostics-entry.ts
var createRelayHostReachability = () => new RelayHostReachabilityLatch();
function getTroubleshootCommonIssues(endpoints, translator2) {
  return withTranslation(translator2, () => troubleshootCommonIssues(translate, endpoints));
}
function describeDesktopConnection(args, translator2) {
  return withTranslation(translator2, () => {
    const verdict = classifyConnection(args);
    return { kind: verdict.kind, label: verdictDisplayLabel(verdict), detail: verdict.detail };
  });
}
