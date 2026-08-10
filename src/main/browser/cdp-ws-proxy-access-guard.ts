import type { IncomingMessage } from 'node:http'

// Why: loopback alone cannot stop browser WebSockets or DNS-rebound discovery requests.
export function isAllowedCdpProxyRequest(req: IncomingMessage, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false
  }

  const { rawHeaders } = req
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    return false
  }

  let rawHost: string | undefined
  let hasRawOrigin = false
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') {
      return false
    }
    if (name.toLowerCase() === 'origin') {
      hasRawOrigin = true
    }
    if (name.toLowerCase() === 'host') {
      if (rawHost !== undefined) {
        return false
      }
      rawHost = value
    }
  }

  const host = req.headers.host
  if (
    hasRawOrigin ||
    req.headers.origin !== undefined ||
    typeof host !== 'string' ||
    host !== rawHost
  ) {
    return false
  }

  const authority = host.toLowerCase()
  return (
    authority === `127.0.0.1:${port}` ||
    authority === `localhost:${port}` ||
    authority === `[::1]:${port}`
  )
}
