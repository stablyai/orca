import { WebSocket } from 'ws'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

export async function verifyHostedWebViewExecutableIsolation({
  document,
  probeId,
  settleDelayMs = 500,
  WebSocketCtor = WebSocket
}) {
  if (!document?.webSocketDebuggerUrl) {
    throw new Error('Hosted WebView inspector target is unavailable')
  }
  if (typeof probeId !== 'string' || probeId.length === 0) {
    throw new Error('Hosted WebView executable probe token is unavailable')
  }
  await delay(settleDelayMs)
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `String(globalThis.__orcaDebugExecutableProbeCompletion ?? '')`,
    WebSocketCtor
  )
  let result
  try {
    result = JSON.parse(value)
  } catch {
    throw new Error('Hosted WebView executable probe did not complete')
  }
  const expected = {
    token: probeId,
    activeDeclaredScriptLoaded: true,
    undeclaredScriptBlocked: true,
    documentRetained: true
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Object.entries(expected).some(([key, expectedValue]) => result[key] !== expectedValue)
  ) {
    throw new Error(`Hosted WebView executable isolation failed: ${JSON.stringify(result)}`)
  }
  return {
    activeDeclaredScriptLoaded: result.activeDeclaredScriptLoaded,
    undeclaredScriptBlocked: result.undeclaredScriptBlocked,
    documentRetained: result.documentRetained
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
