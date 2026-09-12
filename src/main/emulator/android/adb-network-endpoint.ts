// Pure grammar for an ADB TCP endpoint (`host:port`), as typed by a user and as
// it appears verbatim in `adb devices -l` once connected. No I/O: parsing only.

export type AdbNetworkEndpoint = { host: string; port: number }
export type AdbNetworkEndpointError = { error: 'invalid' | 'unsupported_ipv6'; message: string }
export type AdbNetworkEndpointResult = AdbNetworkEndpoint | AdbNetworkEndpointError

// Matches any whitespace (space, tab, newline, ...) or C0/DEL control byte.
// eslint-disable-next-line no-control-regex -- intentional: rejecting control bytes is the point
const WHITESPACE_OR_CONTROL = /[\s\x00-\x1f\x7f]/
const HOSTNAME_LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const IPV4_OCTETS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const DIGITS_ONLY = /^[0-9]+$/

function invalid(message: string): AdbNetworkEndpointError {
  return { error: 'invalid', message }
}

// A dotted-quad-shaped host (e.g. "999.1.1.1") is also grammatically a valid
// RFC-1123 hostname (all-numeric labels), so once it looks like an IPv4
// literal the octet range is the binding check — it must not silently pass
// through as a "hostname" with an out-of-range octet.
function isValidHostname(host: string): boolean {
  if (IPV4_OCTETS.test(host)) {
    return host.split('.').every((octet) => Number(octet) <= 255)
  }
  return host.split('.').every((label) => HOSTNAME_LABEL.test(label))
}

// Parses `host:port` per the v1 grammar: hostname (RFC-1123 labels) or IPv4
// literal, an explicit numeric port 1..65535. Preserves the input verbatim
// (no localhost rewriting, no case normalization) — the parsed value is only
// used for validation, the caller keeps the original string as the address.
export function parseAdbNetworkEndpoint(input: string): AdbNetworkEndpointResult {
  if (input === '') {
    return invalid('Address is empty.')
  }
  if (WHITESPACE_OR_CONTROL.test(input)) {
    return invalid('Address must not contain whitespace or control characters.')
  }
  // Bracketed IPv6 is a distinct, explicit v1 rejection (not "invalid syntax") so
  // the UI can point at the real reason instead of a generic parse error.
  if (input.includes('[') || input.includes(']')) {
    return {
      error: 'unsupported_ipv6',
      message: 'IPv6 addresses are not supported yet. Use a hostname or IPv4 address.'
    }
  }
  if (input.includes('://')) {
    return invalid('Address must be host:port, not a URL.')
  }
  if (input.includes('@')) {
    return invalid('Address must not include credentials.')
  }
  if (input.includes('/')) {
    return invalid('Address must not include a path.')
  }

  const sep = input.lastIndexOf(':')
  if (sep === -1) {
    return invalid('Address must include a port, e.g. host:5555.')
  }
  const host = input.slice(0, sep)
  const portText = input.slice(sep + 1)

  if (host === '') {
    return invalid('Address is missing a host.')
  }
  if (!isValidHostname(host)) {
    return invalid(`"${host}" is not a valid hostname or IPv4 address.`)
  }
  if (portText === '') {
    return invalid('Address is missing a port.')
  }
  // DIGITS_ONLY rejects a leading +/- along with any non-numeric port text.
  if (!DIGITS_ONLY.test(portText)) {
    return invalid('Port must be a number.')
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) {
    return invalid('Port must be between 1 and 65535.')
  }

  return { host, port }
}

// Recognizes `host:port`-shaped serials as adb reports them, for bridge
// routing and backend guards. Bracketed IPv6 is not a real adb serial shape,
// so it (like any other invalid input) is not a network serial.
export function isAdbNetworkSerial(serial: string): boolean {
  return !('error' in parseAdbNetworkEndpoint(serial))
}
