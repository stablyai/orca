import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

const OBSERVATION_PROPERTY = '__orcaE2eBridgeErrorObservation'

export async function startHostedWebViewBridgeErrorObservation(document) {
  const expression = `(() => {
    const key = ${JSON.stringify(OBSERVATION_PROPERTY)};
    const previous = globalThis[key];
    if (previous) {
      previous.errors.length = 0;
      previous.requests = Object.create(null);
      return JSON.stringify({ started: true });
    }
    const native = globalThis.OrcaNative;
    if (!native || typeof native.postMessage !== 'function') {
      return JSON.stringify({ started: false });
    }
    const state = globalThis[key] = {
      errors: [],
      requests: Object.create(null)
    };
    addEventListener('message', (event) => {
      try {
        const message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        if (message?.type !== 'response' || message?.status !== 'error') return;
        const request = state.requests[message.requestId];
        state.errors.push({
          capability: request?.capability ?? 'unknown',
          operation: request?.operation ?? 'unknown',
          code: message.error?.code ?? 'unknown',
          retryable: message.error?.retryable === true
        });
        if (state.errors.length > 64) state.errors.shift();
      } catch {}
    });
    globalThis.OrcaNative = Object.freeze({
      postMessage(value) {
        try {
          const message = JSON.parse(value);
          if (message?.type === 'request' && typeof message.requestId === 'string') {
            state.requests[message.requestId] = {
              capability: String(message.capability ?? '').slice(0, 64),
              operation: String(message.operation ?? '').slice(0, 64)
            };
          }
        } catch {}
        native.postMessage(value);
      }
    });
    return JSON.stringify({ started: true });
  })()`
  const result = JSON.parse(await evaluateHostedDocumentWithRetry(document, expression))
  if (result?.started !== true) {
    throw new Error('Hosted WebView bridge error observation could not start')
  }
}

export async function readHostedWebViewBridgeErrors(document) {
  const expression = `JSON.stringify(globalThis[${JSON.stringify(
    OBSERVATION_PROPERTY
  )}]?.errors ?? [])`
  const errors = JSON.parse(await evaluateHostedDocumentWithRetry(document, expression))
  return Array.isArray(errors) ? errors : []
}
