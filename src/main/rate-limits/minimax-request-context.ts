import { net, session, type Session } from 'electron'
import type { MiniMaxEndpoint } from '../../shared/global-settings-types'

// Why: MiniMax operates two Coding Plan usage endpoints — overseas and CN.
// Both accept cookie auth and Bearer (API key) auth, so the only thing
// that changes between the two is the host URL. Pinning the URLs in one
// place keeps auth and routing in sync.
const MINIMAX_USAGE_PATH = '/v1/api/openplatform/coding_plan/remains'
const MINIMAX_OVERSEAS_BASE = 'https://platform.minimax.io'
const MINIMAX_CN_BASE = 'https://www.minimaxi.com'

export function getMiniMaxEndpointUrl(endpoint: MiniMaxEndpoint): string {
  // Why: returned as a string rather than a { base, path } object so call
  // sites can pass it straight to net.fetch. Joining the path avoids the
  // caller accidentally double-skipping or double-applying the slash.
  if (endpoint === 'cn') {
    return `${MINIMAX_CN_BASE}${MINIMAX_USAGE_PATH}`
  }
  return `${MINIMAX_OVERSEAS_BASE}${MINIMAX_USAGE_PATH}`
}

/**
 * @deprecated Prefer `getMiniMaxEndpointUrl('overseas')`. Kept for the
 * status-bar copy and any older callers that still compare against the
 * hardcoded URL string.
 */
export const MINIMAX_USAGE_ENDPOINT = getMiniMaxEndpointUrl('overseas')

// Why: each endpoint has its own origin and console URL. The cookie jar
// keys cookies by origin, so a CN request must store cookies under
// https://www.minimaxi.com — otherwise Electron's session won't send them
// to the CN host. Computing these from the endpoint URL keeps auth, jar,
// and Referer in lockstep.
function getMiniMaxOrigin(endpoint: MiniMaxEndpoint): string {
  return endpoint === 'cn' ? MINIMAX_CN_BASE : MINIMAX_OVERSEAS_BASE
}

function getMiniMaxReferer(endpoint: MiniMaxEndpoint): string {
  return `${getMiniMaxOrigin(endpoint)}/console/usage`
}

const MINIMAX_SESSION_PARTITION = 'orca-minimax-rate-limit-fetch'
const SENSITIVE_COOKIE_NAMES = new Set([
  '_token',
  '_twpid',
  '_abck',
  'ak_bmsc',
  'bm_mi',
  'bm_sv',
  'bm_sz',
  'minimax_group_id_v2'
])

const MINIMAX_API_KEY_TIMEOUT_MS = 10_000

export type MiniMaxFetchTransport = 'session-cookie-jar' | 'manual-cookie-header' | 'api-key'

export type MiniMaxFetchResponse = {
  response: Response
  requestHeaderNames: string[]
  cookieNames: string[]
  transport: MiniMaxFetchTransport
}

// Why: MiniMax's usage endpoint rejects non-browser clients, so we send a real
// per-platform Firefox UA instead of a custom agent string. Don't "clean up".
function getMiniMaxBrowserUserAgent(): string {
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
  }
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
  }
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'
}

function parseCookiePairs(cookie: string): { name: string; value: string }[] {
  const headerPairs = cookie
    .split(';')
    .map((part) => part.trim())
    .map((part) => {
      const normalizedPart = part.replace(/^Cookie:\s*/i, '')
      const eq = normalizedPart.indexOf('=')
      if (eq === -1) {
        return null
      }
      return {
        name: normalizedPart.slice(0, eq).trim(),
        value: normalizedPart.slice(eq + 1).trim()
      }
    })
    .filter((pair): pair is { name: string; value: string } => Boolean(pair?.name && pair.value))
  // Why: Chromium cookie storage exports are often copied as `name:"value"`,
  // not as an HTTP `Cookie` header. Accept both formats to avoid credential UX traps.
  const quotedCookiePairPattern = /(?:^|[;\s])([A-Za-z0-9_.-]+)\s*:\s*["']([^"']+)["']/g
  const quotedPairs = [...cookie.matchAll(quotedCookiePairPattern)]
    .map((match) => {
      const [, name = '', value = ''] = match
      return { name: name.trim(), value: value.trim() }
    })
    .filter((pair) => pair.name && pair.value)
  return [...headerPairs, ...quotedPairs]
}

export function extractMiniMaxCookieValue(cookie: string, name: string): string | null {
  return parseCookiePairs(cookie).find((pair) => pair.name === name)?.value ?? null
}

export function normalizeMiniMaxCookieHeader(cookie: string): string {
  return parseCookiePairs(cookie)
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('; ')
}

export function getUniqueMiniMaxCookieNames(cookie: string): string[] {
  return [...new Set(parseCookiePairs(cookie).map((pair) => pair.name))]
}

export function redactMiniMaxSecret(value: string): string {
  let redacted = value.replace(/Cookie:\s*[^\n\r]+/gi, 'Cookie: [REDACTED]')
  for (const name of SENSITIVE_COOKIE_NAMES) {
    redacted = redacted
      .replace(new RegExp(`${name}=([^;\\s]+)`, 'g'), `${name}=[REDACTED]`)
      // Match parseCookiePairs' `\s*:\s*` tolerance so `name : "secret"` is redacted too.
      .replace(new RegExp(`${name}\\s*:\\s*["'][^"']+["']`, 'g'), `${name}:[REDACTED]`)
  }
  return redacted
}

export function makeMiniMaxRequestHeaders(
  groupId: string | null,
  endpoint: MiniMaxEndpoint
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: getMiniMaxReferer(endpoint),
    'User-Agent': getMiniMaxBrowserUserAgent()
  }
  if (groupId) {
    headers['X-Group-Id'] = groupId
  }
  return headers
}

async function clearMiniMaxSessionCookieJarForSession(
  miniMaxSession: Session,
  origin: string
): Promise<void> {
  await miniMaxSession.clearStorageData({ origin, storages: ['cookies'] })
}

export async function clearMiniMaxSessionCookieJar(): Promise<void> {
  // Why: clear cookies under both origins so a user who switches endpoint
  // (overseas -> CN or vice versa) does not leave stale cookies that the
  // next request might pick up against the wrong host.
  const miniMaxSession = session.fromPartition(MINIMAX_SESSION_PARTITION)
  await Promise.all([
    clearMiniMaxSessionCookieJarForSession(miniMaxSession, getMiniMaxOrigin('overseas')),
    clearMiniMaxSessionCookieJarForSession(miniMaxSession, getMiniMaxOrigin('cn'))
  ])
}

export async function fetchMiniMaxWithSessionCookieJar(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  endpointMode: MiniMaxEndpoint
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  const miniMaxSession = session.fromPartition(MINIMAX_SESSION_PARTITION)
  const cookiePairs = parseCookiePairs(args.cookie)
  const origin = getMiniMaxOrigin(args.endpointMode)
  try {
    await clearMiniMaxSessionCookieJarForSession(miniMaxSession, origin)
    await Promise.all(
      cookiePairs.map((pair) =>
        miniMaxSession.cookies.set({
          url: origin,
          name: pair.name,
          value: pair.value,
          secure: true,
          path: '/'
        })
      )
    )
    const headers = makeMiniMaxRequestHeaders(args.groupId, args.endpointMode)
    return {
      response: await miniMaxSession.fetch(args.endpoint, {
        method: 'GET',
        headers,
        signal: args.signal
      }),
      requestHeaderNames: Object.keys(headers),
      cookieNames: getUniqueMiniMaxCookieNames(args.cookie),
      transport: 'session-cookie-jar'
    }
  } finally {
    await clearMiniMaxSessionCookieJarForSession(miniMaxSession, origin).catch((error: unknown) => {
      console.warn('[minimax] failed to clear session cookie jar after fetch', error)
    })
  }
}

export async function fetchMiniMaxWithManualCookieHeader(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  endpointMode: MiniMaxEndpoint
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  const miniMaxSession = session.fromPartition(MINIMAX_SESSION_PARTITION)
  const origin = getMiniMaxOrigin(args.endpointMode)
  try {
    await clearMiniMaxSessionCookieJarForSession(miniMaxSession, origin)
    const headers = {
      ...makeMiniMaxRequestHeaders(args.groupId, args.endpointMode),
      Cookie: normalizeMiniMaxCookieHeader(args.cookie)
    }
    return {
      response: await miniMaxSession.fetch(args.endpoint, {
        method: 'GET',
        headers,
        signal: args.signal
      }),
      requestHeaderNames: Object.keys(headers),
      cookieNames: getUniqueMiniMaxCookieNames(args.cookie),
      transport: 'manual-cookie-header'
    }
  } finally {
    await clearMiniMaxSessionCookieJarForSession(miniMaxSession, origin).catch((error: unknown) => {
      console.warn('[minimax] failed to clear session cookie jar after fetch', error)
    })
  }
}

/**
 * Fetch MiniMax usage with a Bearer (API key) token. Works on both
 * overseas and CN endpoints — the key never leaves the renderer.
 */
export async function fetchMiniMaxWithApiKey(args: {
  apiKey: string
  endpoint: string
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  // Why: net.fetch routes through Electron's URL stack, matching the cookie
  // transport's surface area and avoiding Node's TLS quirks for CN routing.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.apiKey}`,
    Accept: 'application/json'
  }
  const response = await net.fetch(args.endpoint, {
    method: 'GET',
    headers,
    signal: args.signal
  })
  return {
    response,
    requestHeaderNames: Object.keys(headers),
    cookieNames: [],
    transport: 'api-key'
  }
}

export { MINIMAX_API_KEY_TIMEOUT_MS }

export function logMiniMaxFetchFailure(details: {
  transport: MiniMaxFetchTransport
  responseStatus?: number
  statusCode?: unknown
  statusMsg?: unknown
  cookieNames: string[]
  requestHeaderNames: string[]
}): void {
  console.warn('[minimax] usage fetch failed', {
    transport: details.transport,
    responseStatus: details.responseStatus,
    baseRespStatusCode: details.statusCode,
    baseRespStatusMsg:
      typeof details.statusMsg === 'string'
        ? redactMiniMaxSecret(details.statusMsg)
        : details.statusMsg,
    cookieNames: details.cookieNames,
    requestHeaderNames: details.requestHeaderNames
  })
}
