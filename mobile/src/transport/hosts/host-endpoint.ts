import { hostEndpointCopy } from './host-endpoint-copy'

// Normalize Edit Host input to a websocket authority without requiring re-pairing.

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
    // Normalize IPv6 brackets because URL implementations differ.
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

// Re-read authority ports because URL.port hides explicit scheme-default :80/:443.
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
  // Reject explicit invalid ports rather than treating them as missing and silently using fallbackPort.
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
    return { ok: false, error: hostEndpointCopy.addressRequired() }
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
    return { ok: false, error: hostEndpointCopy.invalidPort() }
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input)?.[1]?.toLowerCase()
  if (scheme !== 'ws' && scheme !== 'wss') {
    return { ok: false, error: hostEndpointCopy.invalidScheme() }
  }

  const rawAuthority = parseRawSchemeAuthority(input)
  if (rawAuthority.hasUserInfo) {
    return { ok: false, error: hostEndpointCopy.invalidAddress() }
  }
  if (rawAuthority.hasPathOrQuery) {
    return { ok: false, error: hostEndpointCopy.pathOrQueryNotAllowed() }
  }
  if (
    rawAuthority.hostname &&
    validateNumericIpv4Candidate(normalizeRawNumericIpv4Candidate(rawAuthority.hostname))
  ) {
    return { ok: false, error: hostEndpointCopy.invalidHostname() }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, error: hostEndpointCopy.invalidAddress() }
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, error: hostEndpointCopy.invalidScheme() }
  }
  if (!url.hostname) {
    return { ok: false, error: hostEndpointCopy.hostnameRequired() }
  }

  // Reject path/query/userinfo instead of silently stripping address typos.
  if (url.username || url.password) {
    return { ok: false, error: hostEndpointCopy.invalidAddress() }
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, error: hostEndpointCopy.pathOrQueryNotAllowed() }
  }

  const hostname = unwrapHostname(url.hostname)
  // Reject legacy IPv4 aliases that WHATWG URL would rewrite to a different address.
  if (rawAuthority.hostname && isCanonicalIpv4(hostname) && rawAuthority.hostname !== hostname) {
    return { ok: false, error: hostEndpointCopy.invalidHostname() }
  }
  const hostError = validateHostname(hostname)
  if (hostError) {
    return { ok: false, error: hostError }
  }

  // Preserve explicit default ports; URL.port would otherwise replace them with fallbackPort.
  const resolvedPort = resolveWebsocketUrlPort(input, url)
  if (resolvedPort.kind === 'invalid') {
    return { ok: false, error: hostEndpointCopy.invalidPort() }
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
      return { ok: false, error: hostEndpointCopy.invalidAddress() }
    }
    host = input.slice(1, close)
    const rest = input.slice(close + 1)
    if (rest.startsWith(':')) {
      port = rest.slice(1)
    } else if (rest.length > 0) {
      return { ok: false, error: hostEndpointCopy.invalidAddress() }
    }
  } else {
    const firstColon = input.indexOf(':')
    const lastColon = input.lastIndexOf(':')
    if (firstColon !== -1 && firstColon === lastColon) {
      host = input.slice(0, firstColon)
      port = input.slice(firstColon + 1)
    } else {
      host = input
    }
  }

  host = host.trim()
  if (!host) {
    return { ok: false, error: hostEndpointCopy.hostnameRequired() }
  }

  // Validate bare hosts too; URL-only delimiters must never become hostname bytes.
  const hostError = validateHostname(host)
  if (hostError) {
    return { ok: false, error: hostError }
  }

  if (port !== undefined) {
    port = port.trim()
    if (!isValidPort(port)) {
      return { ok: false, error: hostEndpointCopy.invalidPort() }
    }
  }

  const finalPort = port ?? fallbackPort
  return { ok: true, endpoint: `${fallbackScheme}://${formatHostForUrl(host)}:${finalPort}` }
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function validateHostname(host: string): string | null {
  if (!host) {
    return hostEndpointCopy.hostnameRequired()
  }
  if (/[\s/?#@[\]]/.test(host)) {
    return hostEndpointCopy.invalidHostname()
  }
  const numericIpv4Error = validateNumericIpv4Candidate(host)
  if (numericIpv4Error) {
    return numericIpv4Error
  }
  if (host.includes(':')) {
    // Use the WebSocket URL parser to reject malformed IPv6 that a hex/colon regex accepts.
    if (!/^[0-9a-fA-F:]+$/.test(host)) {
      return hostEndpointCopy.invalidHostname()
    }
    try {
      new URL(`ws://[${host}]:${DEFAULT_PORT}`)
    } catch {
      return hostEndpointCopy.invalidHostname()
    }
    return null
  }
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      host
    )
  ) {
    return hostEndpointCopy.invalidHostname()
  }
  return null
}

function validateNumericIpv4Candidate(host: string): string | null {
  if (!NUMERIC_IPV4_CANDIDATE.test(host)) {
    return null
  }
  if (!isCanonicalIpv4(host)) {
    return hostEndpointCopy.invalidHostname()
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
