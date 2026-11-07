/**
 * Listener filters, checked in the preload's isolated world for the main-world installer (which
 * must stay self-contained): webNavigation's events.UrlFilter lists and webRequest's RequestFilter.
 */

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields => value !== null && typeof value === 'object'

const matchesUrlFilter = (rawUrl: string, filter: unknown): boolean => {
  if (!isObject(filter)) {
    return true
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const host = url.hostname
  const path = url.pathname
  const query = url.search.replace(/^\?/, '')
  const plain = rawUrl.split('#')[0]
  const checks: Record<string, (value: string) => boolean> = {
    hostContains: (value) => `.${host}`.includes(value),
    hostEquals: (value) => host === value,
    hostPrefix: (value) => host.startsWith(value),
    hostSuffix: (value) => host.endsWith(value),
    pathContains: (value) => path.includes(value),
    pathEquals: (value) => path === value,
    pathPrefix: (value) => path.startsWith(value),
    pathSuffix: (value) => path.endsWith(value),
    queryContains: (value) => query.includes(value),
    queryEquals: (value) => query === value,
    queryPrefix: (value) => query.startsWith(value),
    querySuffix: (value) => query.endsWith(value),
    urlContains: (value) => plain.includes(value),
    urlEquals: (value) => plain === value,
    urlPrefix: (value) => plain.startsWith(value),
    urlSuffix: (value) => plain.endsWith(value),
    urlMatches: (value) => new RegExp(value).test(plain)
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'schemes' && Array.isArray(value) && !value.includes(url.protocol.slice(0, -1))) {
      return false
    }
    if (key === 'ports' && Array.isArray(value)) {
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      const ok = value.some((entry) =>
        Array.isArray(entry) ? port >= entry[0] && port <= entry[1] : entry === port
      )
      if (!ok) {
        return false
      }
    }
    if (typeof value === 'string' && checks[key] && !checks[key](value)) {
      return false
    }
  }
  return true
}
// chrome.webRequest.RequestFilter patterns follow Chrome's match-pattern rules.
const matchesPattern = (pattern: unknown, rawUrl: string): boolean => {
  if (typeof pattern !== 'string') {
    return false
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const scheme = url.protocol.slice(0, -1)
  if (pattern === '<all_urls>') {
    return ['http', 'https', 'ws', 'wss', 'file', 'ftp'].includes(scheme)
  }
  const parts = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern)
  if (!parts) {
    return false
  }
  const [, wantScheme, wantHost = '', wantPath] = parts
  const schemeOk =
    wantScheme === '*' ? ['http', 'https', 'ws', 'wss'].includes(scheme) : wantScheme === scheme
  const host = url.hostname.toLowerCase()
  const wanted = wantHost.toLowerCase()
  const hostOk =
    wanted === '*' ||
    (wanted.startsWith('*.')
      ? host === wanted.slice(2) || host.endsWith(wanted.slice(1))
      : host === wanted)
  const escaped = wantPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return schemeOk && hostOk && new RegExp(`^${escaped}$`).test(`${url.pathname}${url.search}`)
}
const passesRequestFilter = (args: unknown[], filter: unknown): boolean => {
  const details = args[0]
  if (!isObject(filter) || !isObject(details) || typeof details.url !== 'string') {
    return true
  }
  const url = details.url
  if (Array.isArray(filter.urls) && !filter.urls.some((pattern) => matchesPattern(pattern, url))) {
    return false
  }
  if (Array.isArray(filter.types) && !filter.types.includes(details.type)) {
    return false
  }
  if (typeof filter.tabId === 'number' && filter.tabId !== details.tabId) {
    return false
  }
  return typeof filter.windowId !== 'number' || filter.windowId === details.windowId
}
export const passesBrowserExtensionEventFilter = (
  namespace: string,
  args: unknown[],
  filter: unknown
): boolean => {
  if (namespace === 'webRequest') {
    return passesRequestFilter(args, filter)
  }
  if (!isObject(filter) || !Array.isArray(filter.url)) {
    return true
  }
  const details = args[0]
  const url = isObject(details) ? details.url : undefined
  return typeof url === 'string' && filter.url.some((entry) => matchesUrlFilter(url, entry))
}
