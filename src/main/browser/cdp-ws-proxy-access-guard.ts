import type { IncomingMessage } from 'node:http'

// Why: the proxy hands out full Chrome DevTools Protocol control of a live, logged-in
// browser tab. Binding to loopback is not access control against a browser: WebSocket
// handshakes are exempt from the same-origin policy, and DNS rebinding turns a public
// origin into a same-origin reader of the HTTP discovery endpoints. Chrome guards its
// own remote-debugging endpoint the same two ways.
const LOOPBACK_PROXY_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * A browser always sends `Origin` on a WebSocket handshake and on cross-origin fetches;
 * CDP clients (agent-browser, Playwright, chrome-remote-interface) never do. Any request
 * carrying `Origin` therefore came from web content and must not reach the debugger.
 * Presence is the whole signal — the value is never inspected, so an empty or `null`
 * Origin is rejected exactly like a named one.
 */
function hasBrowserOrigin(req: IncomingMessage): boolean {
  return req.headers.origin !== undefined
}

/**
 * `Host` must name loopback at the port we actually bound. This is what stops DNS
 * rebinding: a rebound page reaches 127.0.0.1 but still sends the attacker's hostname.
 */
function hasLoopbackHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || port === 0) {
    return false
  }
  const separator = host.lastIndexOf(':')
  if (separator === -1 || host.endsWith(']')) {
    return false
  }
  if (Number(host.slice(separator + 1)) !== port) {
    return false
  }
  return LOOPBACK_PROXY_HOSTNAMES.has(host.slice(0, separator).toLowerCase())
}

export function isAllowedCdpProxyRequest(req: IncomingMessage, port: number): boolean {
  return !hasBrowserOrigin(req) && hasLoopbackHost(req, port)
}
