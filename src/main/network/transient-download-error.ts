export type HttpStatusError = Error & {
  httpStatusCode?: number
  retryAfterMs?: number
  retryable?: boolean
}

const RETRYABLE_NET_ERROR =
  /net::ERR_(CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_(RESET|CLOSED|ABORTED|REFUSED|TIMED_OUT)|EMPTY_RESPONSE|NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NAME_NOT_RESOLVED|SOCKET_NOT_CONNECTED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b/
// Node reports mid-body aborts by code; Chromium uses net::ERR_* messages.
const RETRYABLE_NODE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE'
])
const RETRYABLE_HTTP_STATUSES = new Set([408, 416, 425, 429, 500, 502, 503, 504])

export function isRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const downloadError: HttpStatusError = error
  if (downloadError.retryable === true) {
    return true
  }
  const statusCode = downloadError.httpStatusCode
  if (statusCode !== undefined) {
    return RETRYABLE_HTTP_STATUSES.has(statusCode)
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  return (
    RETRYABLE_NET_ERROR.test(error.message) ||
    error.message.includes('without network activity') ||
    (code !== null && RETRYABLE_NODE_ERROR_CODES.has(code))
  )
}
