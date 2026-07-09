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
    // Why: URL.hostname strips IPv6 brackets; re-wrap so round-trip through
    // normalizeHostEndpoint does not treat "addr:port" as a single host.
    const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
    return `${host}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
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

  const port = url.port || fallbackPort
  if (!isValidPort(port)) {
    return { ok: false, error: 'Port must be 1–65535.' }
  }

  // Why: rebuild so path/query noise and accidental whitespace never reach the
  // WebSocket constructor; pairing offers are host:port only.
  return { ok: true, endpoint: `${url.protocol}//${formatHostForUrl(url.hostname)}:${port}` }
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

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false
  }
  const n = Number(port)
  return n >= 1 && n <= 65535
}
