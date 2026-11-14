import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** Reject browser origins and require a loopback Host to prevent web-page access and DNS rebinding. */
function isTrustedCdpLoopbackRequest(req: IncomingMessage, port: number): boolean {
  if (req.headers.origin !== undefined) {
    return false
  }
  const host = req.headers.host?.toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

/**
 * Other local processes can reach the loopback port, so every request must start with
 * `/<token>`. Returns the remaining path, or null when the token is missing or wrong.
 */
function stripCdpProxyTokenPath(url: string | undefined, token: string): string | null {
  const path = url ?? ''
  const end = path.indexOf('/', 1)
  const segment = Buffer.from(end === -1 ? path.slice(1) : path.slice(1, end))
  const expected = Buffer.from(token)
  if (
    !path.startsWith('/') ||
    segment.length !== expected.length ||
    !timingSafeEqual(segment, expected)
  ) {
    return null
  }
  return end === -1 ? '/' : path.slice(end)
}

/** Returns the path after the token, or the status to reject with: 403 for web/rebound requests, 404 otherwise. */
export function admitCdpProxyRequest(
  req: IncomingMessage,
  port: number,
  token: string
): { path: string } | { status: 403 | 404 } {
  if (!isTrustedCdpLoopbackRequest(req, port)) {
    return { status: 403 }
  }
  const path = stripCdpProxyTokenPath(req.url, token)
  return path === null ? { status: 404 } : { path }
}

export function verifyCdpProxyUpgrade(
  req: IncomingMessage,
  port: number,
  token: string,
  done: (result: boolean, code?: number) => void
): void {
  const admission = admitCdpProxyRequest(req, port, token)
  done(!('status' in admission), 'status' in admission ? admission.status : undefined)
}
