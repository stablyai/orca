// Why: mobile host profiles store a single websocket endpoint fixed at pair
// time. Edit-host lets the user rewrite host/port without re-pairing; this
// helper accepts phone-friendly input (bare IP, host:port, or full ws URL)
// and normalizes to the ws(s):// form RpcClient expects.

export type NormalizeHostEndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; error: string }

const DEFAULT_PORT = '6768'

export function displayHostEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    // Why: some URL parsers leave IPv6 brackets on hostname, others strip them.
    // Normalize once so round-trip through normalizeHostEndpoint stays stable.
    const host = formatHostForUrl(unwrapHostname(url.hostname))
    return `${host}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

function unwrapHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export function endpointPort(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    return url.port || undefined
  } catch {
    return undefined
  }
}

export function endpointScheme(endpoint: string): 'ws' | 'wss' {
  try {
    const protocol = new URL(endpoint).protocol.replace(':', '')
    return protocol === 'wss' ? 'wss' : 'ws'
  } catch {
    return 'ws'
  }
}

export function normalizeHostEndpoint(
  input: string,
  options?: { fallbackPort?: string | number; fallbackScheme?: 'ws' | 'wss' }
): NormalizeHostEndpointResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: 'Enter a host address.' }
  }

  const fallbackPort = resolveFallbackPort(options?.fallbackPort)
  const fallbackScheme = options?.fallbackScheme === 'wss' ? 'wss' : 'ws'

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return normalizeSchemeUrl(trimmed, fallbackPort)
  }

  return normalizeHostPort(trimmed, fallbackPort, fallbackScheme)
}

function resolveFallbackPort(value: string | number | undefined): string {
  if (value == null) {
    return DEFAULT_PORT
  }
  const asString = String(value).trim()
  if (!asString || !isValidPort(asString)) {
    return DEFAULT_PORT
  }
  return asString
}

function normalizeSchemeUrl(input: string, fallbackPort: string): NormalizeHostEndpointResult {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, error: 'Not a valid address.' }
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, error: 'Use ws:// or wss:// (or host:port).' }
  }
  if (!url.hostname) {
    return { ok: false, error: 'Missing hostname.' }
  }

  // Why: edit-host persists a bare host:port WebSocket endpoint. Path/query/
  // userinfo are not part of the pairing contract — reject rather than strip
  // so typos like desk/path or desk?route cannot be saved silently.
  if (url.username || url.password) {
    return { ok: false, error: 'Not a valid address.' }
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, error: 'Host must not include a path or query.' }
  }

  const hostname = unwrapHostname(url.hostname)
  const hostError = validateHostname(hostname)
  if (hostError) {
    return { ok: false, error: hostError }
  }

  const port = url.port || fallbackPort
  if (!isValidPort(port)) {
    return { ok: false, error: 'Port must be 1–65535.' }
  }

  // Why: rebuild so accidental whitespace never reaches the WebSocket constructor.
  return { ok: true, endpoint: `${url.protocol}//${formatHostForUrl(hostname)}:${port}` }
}

function normalizeHostPort(
  input: string,
  fallbackPort: string,
  fallbackScheme: 'ws' | 'wss'
): NormalizeHostEndpointResult {
  let host: string
  let port: string | undefined

  if (input.startsWith('[')) {
    const close = input.indexOf(']')
    if (close <= 1) {
      return { ok: false, error: 'Not a valid address.' }
    }
    host = input.slice(1, close)
    const rest = input.slice(close + 1)
    if (rest.startsWith(':')) {
      port = rest.slice(1)
    } else if (rest.length > 0) {
      return { ok: false, error: 'Not a valid address.' }
    }
  } else {
    const firstColon = input.indexOf(':')
    const lastColon = input.lastIndexOf(':')
    if (firstColon !== -1 && firstColon === lastColon) {
      host = input.slice(0, firstColon)
      port = input.slice(firstColon + 1)
    } else {
      // No port, or bare IPv6 (multiple colons, no brackets).
      host = input
    }
  }

  host = host.trim()
  if (!host) {
    return { ok: false, error: 'Missing hostname.' }
  }

  // Why: bare input is not a URL, so characters that only make sense in a URL
  // (path, query, fragment, whitespace) must not be treated as hostname bytes.
  const hostError = validateHostname(host)
  if (hostError) {
    return { ok: false, error: hostError }
  }

  if (port !== undefined) {
    port = port.trim()
    if (!isValidPort(port)) {
      return { ok: false, error: 'Port must be 1–65535.' }
    }
  }

  const finalPort = port ?? fallbackPort
  return { ok: true, endpoint: `${fallbackScheme}://${formatHostForUrl(host)}:${finalPort}` }
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Reject hostnames that would be illegal or ambiguous in a websocket URL.
 * Allows DNS labels, `.local` mDNS, IPv4, and IPv6 hex forms.
 */
function validateHostname(host: string): string | null {
  if (!host) {
    return 'Missing hostname.'
  }
  // Spaces, path/query/fragment separators, userinfo separators, brackets.
  if (/[\s/?#@[\]]/.test(host)) {
    return 'Not a valid hostname.'
  }
  if (host.includes(':')) {
    // Why: bare IPv6 is hex + colons only (brackets already stripped).
    if (!/^[0-9a-fA-F:]+$/.test(host) || host.split(':').length < 3) {
      return 'Not a valid hostname.'
    }
    return null
  }
  // DNS / IPv4 / mDNS: labels of alnum and hyphen, dots between, no empty labels.
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      host
    )
  ) {
    return 'Not a valid hostname.'
  }
  return null
}

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false
  }
  const n = Number(port)
  return n >= 1 && n <= 65535
}
