// Why: mobile host profiles store a single websocket endpoint fixed at pair
// time. Edit-host lets the user rewrite host/port without re-pairing; this
// helper accepts phone-friendly input (bare IP, host:port, or full ws URL)
// and normalizes to the ws(s):// form RpcClient expects.

export type NormalizeHostEndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; error: string }

type WebsocketUrlPortResolution =
  | { kind: 'missing' }
  | { kind: 'valid'; port: string }
  | { kind: 'invalid' }

type RawSchemeAuthority = {
  hostname: string | null
  hasUserInfo: boolean
  hasPathOrQuery: boolean
}

const DEFAULT_PORT = '6768'
const NUMERIC_IPV4_CANDIDATE = /^(?:0[xX][0-9a-fA-F]+|\d+)(?:\.(?:0[xX][0-9a-fA-F]+|\d+))*$/

export function displayHostEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    // Why: some URL parsers leave IPv6 brackets on hostname, others strip them.
    // Normalize once so round-trip through normalizeHostEndpoint stays stable.
    const host = formatHostForUrl(unwrapHostname(url.hostname))
    const port = resolveWebsocketUrlPort(endpoint, url)
    if (port.kind === 'invalid') {
      return endpoint
    }
    return port.kind === 'valid' ? `${host}:${port.port}` : host
  } catch {
    return endpoint
  }
}

function unwrapHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Recover an explicitly written port from a ws(s) URL authority.
 * Why: `new URL('ws://host:80').port` and `wss://host:443` are empty — the
 * URL parser hides scheme-default ports, so callers that need the user's
 * literal :80/:443 must re-parse the original string.
 */
function extractExplicitPortFromWebsocketUrl(input: string): string | null {
  const withoutScheme = input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  if (withoutScheme.startsWith('[')) {
    const close = withoutScheme.indexOf(']')
    if (close <= 1) {
      return null
    }
    const rest = withoutScheme.slice(close + 1)
    const match = /^:(\d+)(?=[/?#]|$)/.exec(rest)
    return match?.[1] ?? null
  }
  const end = withoutScheme.search(/[/?#]/)
  const authority = end === -1 ? withoutScheme : withoutScheme.slice(0, end)
  const at = authority.lastIndexOf('@')
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  const match = /:(\d+)$/.exec(hostPort)
  return match?.[1] ?? null
}

function resolveWebsocketUrlPort(input: string, url?: URL): WebsocketUrlPortResolution {
  const explicit = extractExplicitPortFromWebsocketUrl(input)
  // Why: missing and invalid are different states. Treating both as null lets
  // an explicit :0/:99999 silently inherit fallbackPort on permissive parsers.
  if (explicit !== null && !isValidPort(explicit)) {
    return { kind: 'invalid' }
  }
  if (url?.port) {
    return isValidPort(url.port) ? { kind: 'valid', port: url.port } : { kind: 'invalid' }
  }
  if (explicit !== null) {
    return { kind: 'valid', port: explicit }
  }
  return { kind: 'missing' }
}

export function endpointPort(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    const port = resolveWebsocketUrlPort(endpoint, url)
    return port.kind === 'valid' ? port.port : undefined
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
  const explicitPort = resolveWebsocketUrlPort(input)
  if (explicitPort.kind === 'invalid') {
    return { ok: false, error: 'Port must be 1–65535.' }
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input)?.[1]?.toLowerCase()
  if (scheme !== 'ws' && scheme !== 'wss') {
    return { ok: false, error: 'Use ws:// or wss:// (or host:port).' }
  }

  const rawAuthority = parseRawSchemeAuthority(input)
  if (rawAuthority.hasUserInfo) {
    return { ok: false, error: 'Not a valid address.' }
  }
  if (rawAuthority.hasPathOrQuery) {
    return { ok: false, error: 'Host must not include a path or query.' }
  }
  if (
    rawAuthority.hostname &&
    validateNumericIpv4Candidate(normalizeRawNumericIpv4Candidate(rawAuthority.hostname))
  ) {
    return { ok: false, error: 'Not a valid hostname.' }
  }

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
  // Why: WHATWG URL accepts legacy aliases and rewrites them to a different
  // IPv4 address. Only an already-canonical raw dotted quad may become IPv4.
  if (rawAuthority.hostname && isCanonicalIpv4(hostname) && rawAuthority.hostname !== hostname) {
    return { ok: false, error: 'Not a valid hostname.' }
  }
  const hostError = validateHostname(hostname)
  if (hostError) {
    return { ok: false, error: hostError }
  }

  // Why: keep explicit :80/:443 (URL.port is empty for scheme defaults) instead
  // of rewriting them to fallbackPort (usually 6768).
  const resolvedPort = resolveWebsocketUrlPort(input, url)
  if (resolvedPort.kind === 'invalid') {
    return { ok: false, error: 'Port must be 1–65535.' }
  }
  const port = resolvedPort.kind === 'valid' ? resolvedPort.port : fallbackPort

  // Why: rebuild so accidental whitespace never reaches the WebSocket constructor.
  return { ok: true, endpoint: `${url.protocol}//${formatHostForUrl(hostname)}:${port}` }
}

function parseRawSchemeAuthority(input: string): RawSchemeAuthority {
  const schemeEnd = input.indexOf('://')
  const remainder = input.slice(schemeEnd + 3)
  const authorityEnd = remainder.search(/[/?#]/)
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd)
  const suffix = authorityEnd === -1 ? '' : remainder.slice(authorityEnd)
  const hasUserInfo = authority.includes('@')
  const hostPort = hasUserInfo ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (!hostPort) {
    return { hostname: null, hasUserInfo, hasPathOrQuery: suffix !== '' && suffix !== '/' }
  }
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    return {
      hostname: close > 1 ? hostPort.slice(1, close) : null,
      hasUserInfo,
      hasPathOrQuery: suffix !== '' && suffix !== '/'
    }
  }
  const lastColon = hostPort.lastIndexOf(':')
  return {
    hostname: lastColon === -1 ? hostPort : hostPort.slice(0, lastColon),
    hasUserInfo,
    hasPathOrQuery: suffix !== '' && suffix !== '/'
  }
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
  const numericIpv4Error = validateNumericIpv4Candidate(host)
  if (numericIpv4Error) {
    return numericIpv4Error
  }
  if (host.includes(':')) {
    // Why: a hex/colon regex accepts malformed forms such as two `::` runs.
    // Reuse the URL parser that WebSocket will ultimately use.
    if (!/^[0-9a-fA-F:]+$/.test(host)) {
      return 'Not a valid hostname.'
    }
    try {
      new URL(`ws://[${host}]:${DEFAULT_PORT}`)
    } catch {
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

function validateNumericIpv4Candidate(host: string): string | null {
  if (!NUMERIC_IPV4_CANDIDATE.test(host)) {
    return null
  }
  if (!isCanonicalIpv4(host)) {
    return 'Not a valid hostname.'
  }
  return null
}

function normalizeRawNumericIpv4Candidate(host: string): string {
  let decoded = host
  try {
    decoded = decodeURIComponent(host)
  } catch {
    // The URL parser will reject malformed escapes; keep them untouched here.
  }
  return decoded.endsWith('.') ? decoded.slice(0, -1) : decoded
}

function isCanonicalIpv4(host: string): boolean {
  const octets = host.split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  )
}

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false
  }
  const n = Number(port)
  return n >= 1 && n <= 65535
}
