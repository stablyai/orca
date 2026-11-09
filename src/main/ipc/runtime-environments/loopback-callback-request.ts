// The only traffic a generic loopback relay carries: a browser's OAuth redirect to this port.
/** A generic loopback relay (MCP OAuth redirect) lives briefly: the browser hits it within seconds. */
export const GENERIC_RELAY_TTL_MS = 2 * 60_000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** First bytes of an HTTP GET whose Host header names this computer's loopback on `port`. */
export function isLoopbackCallbackRequest(first: Buffer, port: number): boolean {
  const head = first.subarray(0, 8192).toString('latin1')
  const end = head.indexOf('\r\n\r\n')
  const lines = (end === -1 ? head : head.slice(0, end)).split('\r\n')
  if (!/^GET \/\S* HTTP\/1\.[01]$/.test(lines[0] ?? '')) {
    return false
  }
  const hosts = lines.filter((line) => /^host:/i.test(line))
  if (hosts.length !== 1) {
    return false
  }
  const value = hosts[0]!.slice(5).trim().toLowerCase()
  const colon = value.lastIndexOf(':')
  if (colon <= 0 || value.slice(colon + 1) !== String(port)) {
    return false
  }
  return LOOPBACK_HOSTS.has(value.slice(0, colon))
}
