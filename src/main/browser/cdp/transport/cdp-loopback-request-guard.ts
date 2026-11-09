import type { IncomingMessage } from 'node:http'

/** Reject browser origins and require a loopback Host to prevent web-page access and DNS rebinding. */
export function isTrustedCdpLoopbackRequest(req: IncomingMessage, port: number): boolean {
  if (req.headers.origin !== undefined) {
    return false
  }
  const host = req.headers.host?.toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
