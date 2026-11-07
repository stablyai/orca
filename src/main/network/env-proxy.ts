// Resolves a proxy for one URL from the standard proxy environment variables.
// Pure: no I/O and no Electron, so it can be tested without a network.

export type EnvProxyScheme = 'http' | 'https' | 'socks4' | 'socks5' | 'socks5h'

export type EnvProxy = {
  /** Normalised proxy URL, e.g. `socks5h://127.0.0.1:1080`. */
  url: string
  scheme: EnvProxyScheme
}

type Env = Record<string, string | undefined>

const SUPPORTED_SCHEMES: readonly EnvProxyScheme[] = [
  'http',
  'https',
  'socks4',
  'socks5',
  'socks5h'
]

function isEnvProxyScheme(value: string): value is EnvProxyScheme {
  return SUPPORTED_SCHEMES.some((scheme) => scheme === value)
}
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }

function readVar(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function parseProxyUrl(raw: string): EnvProxy | null {
  // `host:port` without a scheme is conventionally an HTTP proxy.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  if (!isEnvProxyScheme(scheme) || !parsed.hostname) {
    return null
  }
  return { url: parsed.href.replace(/\/$/, ''), scheme }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

// Accepts `example.com`, `.example.com`, `*.example.com`, `host:port`, `[::1]:8080`, `*`.
function matchesNoProxyEntry(entry: string, hostname: string, port: number): boolean {
  if (entry === '*') {
    return true
  }
  let host = entry
  let entryPort: number | null = null
  const portMatch = /^(.*):(\d+)$/.exec(entry)
  // A bare IPv6 literal contains colons but no brackets; only split bracketed or hostname forms.
  if (portMatch && (portMatch[1].startsWith('[') || !portMatch[1].includes(':'))) {
    host = portMatch[1]
    entryPort = Number(portMatch[2])
  }
  host = stripBrackets(host)
    .replace(/^\*?\./, '.')
    .toLowerCase()
  if (entryPort !== null && entryPort !== port) {
    return false
  }
  if (!host) {
    return false
  }
  if (host.startsWith('.')) {
    return hostname.endsWith(host) || hostname === host.slice(1)
  }
  return hostname === host || hostname.endsWith(`.${host}`)
}

export function isBypassedByNoProxy(url: URL, env: Env = process.env): boolean {
  const list = readVar(env, 'no_proxy', 'NO_PROXY')
  if (!list) {
    return false
  }
  const hostname = stripBrackets(url.hostname).toLowerCase()
  const port = url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0)
  return list
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((entry) => matchesNoProxyEntry(entry, hostname, port))
}

/** Returns the proxy to use for `target`, or null for a direct connection. */
export function resolveEnvProxy(target: string | URL, env: Env = process.env): EnvProxy | null {
  let url: URL
  try {
    url = typeof target === 'string' ? new URL(target) : target
  } catch {
    return null
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const insecure = url.protocol === 'http:' || url.protocol === 'ws:'
  if (!secure && !insecure) {
    return null
  }
  const raw = secure
    ? readVar(env, 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')
    : readVar(env, 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY')
  if (!raw) {
    return null
  }
  const proxy = parseProxyUrl(raw)
  if (!proxy || isBypassedByNoProxy(url, env)) {
    return null
  }
  return proxy
}
