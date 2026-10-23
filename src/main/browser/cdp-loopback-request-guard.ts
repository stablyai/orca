import type { IncomingMessage } from 'node:http'

/**
 * Admits only same-machine automation clients to the CDP proxy, mirroring Chrome's own DevTools
 * endpoint: browsers always send Origin on a websocket handshake (CDP clients don't), and a
 * non-loopback Host means a DNS-rebound web page. Either would let any site drive the tab and
 * read its cookies.
 */
export function isTrustedCdpLoopbackRequest(req: IncomingMessage, port: number): boolean {
  if (req.headers.origin !== undefined) {
    return false
  }
  const host = req.headers.host?.toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
