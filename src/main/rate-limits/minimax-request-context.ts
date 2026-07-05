import { net, session } from 'electron'

export const MINIMAX_USAGE_ENDPOINT =
  'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains'

const MINIMAX_ORIGIN = 'https://platform.minimax.io'
const MINIMAX_REFERER = 'https://platform.minimax.io/console/usage'
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

export type MiniMaxFetchTransport = 'session-cookie-jar' | 'manual-cookie-header'

export type MiniMaxFetchResponse = {
  response: Response
  requestHeaderNames: string[]
  cookieNames: string[]
  transport: MiniMaxFetchTransport
}

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
      if (eq < 0) {
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
      .replace(new RegExp(`${name}:["'][^"']+["']`, 'g'), `${name}:[REDACTED]`)
  }
  return redacted
}

export function makeMiniMaxRequestHeaders(groupId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: MINIMAX_REFERER,
    'User-Agent': getMiniMaxBrowserUserAgent()
  }
  if (groupId) {
    headers['X-Group-Id'] = groupId
  }
  return headers
}

export async function fetchMiniMaxWithSessionCookieJar(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  const miniMaxSession = session.fromPartition(MINIMAX_SESSION_PARTITION)
  const cookiePairs = parseCookiePairs(args.cookie)
  await miniMaxSession.clearStorageData({ origin: MINIMAX_ORIGIN, storages: ['cookies'] })
  await Promise.all(
    cookiePairs.map((pair) =>
      miniMaxSession.cookies.set({
        url: MINIMAX_ORIGIN,
        name: pair.name,
        value: pair.value,
        secure: true,
        path: '/'
      })
    )
  )
  const headers = makeMiniMaxRequestHeaders(args.groupId)
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
}

export async function fetchMiniMaxWithManualCookieHeader(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  const headers = {
    ...makeMiniMaxRequestHeaders(args.groupId),
    Cookie: args.cookie
  }
  return {
    response: await net.fetch(args.endpoint, {
      method: 'GET',
      headers,
      signal: args.signal
    }),
    requestHeaderNames: Object.keys(headers),
    cookieNames: getUniqueMiniMaxCookieNames(args.cookie),
    transport: 'manual-cookie-header'
  }
}

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
