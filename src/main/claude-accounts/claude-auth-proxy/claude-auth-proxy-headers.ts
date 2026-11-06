import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/** Hop-by-hop and length headers the proxy sets itself when it pipes the body. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
])

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
])

export function forwardRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return copyHeaders(headers, DROPPED_REQUEST_HEADERS)
}

export function forwardResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return copyHeaders(headers, DROPPED_RESPONSE_HEADERS)
}

function copyHeaders(headers: IncomingHttpHeaders, dropped: Set<string>): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name)) {
      continue
    }
    forwarded[name] = value
  }
  return forwarded
}
