import { WebSocket } from 'ws'
import { evaluateHostedWebViewCdp } from './hosted-webview-cdp-evaluation.mjs'

const CDP_TARGET_LIST_MAX_BYTES = 1024 * 1024
export const CDP_TARGET_LIMIT = 16
export const HOSTED_DOCUMENT_TEXT_LIMIT = 8 * 1024

const hostedDocumentProbeExpression = `JSON.stringify({
  href: String(location.href).slice(0, 2048),
  visibility: document.visibilityState,
  focused: document.hasFocus(),
  bridgeListening: window.__orcaMobileWebShellListening === true,
  bodyText: String(document.body?.innerText ?? '').slice(0, ${HOSTED_DOCUMENT_TEXT_LIMIT}),
  buttonCount: document.querySelectorAll('button,[role="button"]').length
})`

export function isHostedMobileWebUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'orca-mobile-web:') {
      return Boolean(url.hostname) && url.port === '' && url.username === '' && url.password === ''
    }
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.hostname === 'orca-mobile-web.invalid' ||
        /^[a-z0-9_-]{1,32}\.orca-mobile-web\.invalid$/i.test(url.hostname))
    )
  } catch {
    return false
  }
}

export async function assertNoHostedMobileWebCdpTarget({
  discoveryUrl,
  fetchImpl = fetch,
  WebSocketCtor = WebSocket
}) {
  const discoveredTargets = await readCdpTargetList(discoveryUrl, fetchImpl)
  if (
    discoveredTargets.some(
      (target) =>
        target &&
        typeof target === 'object' &&
        typeof target.url === 'string' &&
        isHostedMobileWebUrl(target.url)
    )
  ) {
    throw new Error('Native baseline has a hosted mobile WebView CDP target')
  }
  const inspectableTargets = discoveredTargets.filter(isSafeCdpTarget)
  if (inspectableTargets.length > CDP_TARGET_LIMIT) {
    throw new Error('Native baseline CDP target count exceeded its inspection limit')
  }
  const probes = await Promise.all(
    inspectableTargets.map((target) => probeHostedWebView(target, WebSocketCtor))
  )
  if (probes.some((probe) => probe && isHostedMobileWebUrl(probe.href))) {
    throw new Error('Native baseline has a hosted mobile WebView CDP target')
  }
}

export async function readCdpTargets(discoveryUrl, fetchImpl) {
  return (await readCdpTargetList(discoveryUrl, fetchImpl)).filter(isSafeCdpTarget)
}

async function readCdpTargetList(discoveryUrl, fetchImpl) {
  const response = await fetchImpl(new URL('/json/list', discoveryUrl), {
    signal: AbortSignal.timeout(3_000)
  })
  if (!response.ok) {
    throw new Error(`WebKit inspector discovery returned HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > CDP_TARGET_LIST_MAX_BYTES) {
    throw new Error('WebKit inspector target list exceeded its size limit')
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (!Array.isArray(parsed)) {
    throw new Error('WebKit inspector target list was not an array')
  }
  return parsed
}

export async function probeHostedWebView(target, WebSocketCtor) {
  try {
    const value = await evaluateHostedWebViewCdp(
      target.webSocketDebuggerUrl,
      hostedDocumentProbeExpression,
      WebSocketCtor
    )
    const parsed = JSON.parse(value)
    if (
      typeof parsed?.href !== 'string' ||
      typeof parsed.visibility !== 'string' ||
      typeof parsed.focused !== 'boolean' ||
      typeof parsed.bridgeListening !== 'boolean' ||
      typeof parsed.bodyText !== 'string' ||
      typeof parsed.buttonCount !== 'number'
    ) {
      return null
    }
    return {
      ...parsed,
      targetId: target.id,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    }
  } catch {
    return null
  }
}

function isSafeCdpTarget(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    typeof value.webSocketDebuggerUrl !== 'string'
  ) {
    return false
  }
  try {
    const url = new URL(value.webSocketDebuggerUrl)
    return (
      url.protocol === 'ws:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      url.pathname.startsWith('/devtools/page/')
    )
  } catch {
    return false
  }
}
