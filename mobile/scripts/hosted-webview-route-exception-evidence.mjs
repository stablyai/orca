import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'
import { WebSocket } from 'ws'

const CAPTURE_KEY = '__orcaE2eHostedRouteExceptions'
const MAX_ENTRIES = 24
const MAX_TEXT_LENGTH = 4_096

export async function installHostedWebViewRouteExceptionCapture(
  document,
  WebSocketCtor = WebSocket
) {
  await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
      const key = ${JSON.stringify(CAPTURE_KEY)};
      if (globalThis[key]?.installed === true) return 'installed';
      const evidence = { entries: [], installed: true };
      const append = (kind, values) => {
        const text = values.map((value) => {
          if (value instanceof Error) return value.stack || value.message || value.name;
          if (typeof value === 'string') return value;
          try { return JSON.stringify(value); } catch { return String(value); }
        }).join(' ').slice(0, ${MAX_TEXT_LENGTH});
        evidence.entries.push({ kind, text });
        if (evidence.entries.length > ${MAX_ENTRIES}) evidence.entries.shift();
      };
      const originalConsoleError = console.error.bind(console);
      console.error = (...values) => {
        append('console-error', values);
        originalConsoleError(...values);
      };
      addEventListener('error', (event) => append('window-error', [event.error ?? event.message]));
      addEventListener('unhandledrejection', (event) => append('unhandled-rejection', [event.reason]));
      globalThis[key] = evidence;
      return 'installed';
    })()`,
    WebSocketCtor
  )
}

export async function readHostedWebViewRouteExceptionEvidence(document, WebSocketCtor = WebSocket) {
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `JSON.stringify((globalThis[${JSON.stringify(CAPTURE_KEY)}]?.entries ?? []).slice(-${MAX_ENTRIES}))`,
    WebSocketCtor
  )
  const entries = JSON.parse(value)
  if (!Array.isArray(entries)) {
    return []
  }
  return entries.filter(isExceptionEvidenceEntry)
}

function isExceptionEvidenceEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['console-error', 'window-error', 'unhandled-rejection'].includes(value.kind) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_TEXT_LENGTH
  )
}
