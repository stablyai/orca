/** Download failures a later attempt may not hit: dropped connections, timeouts, 5xx. */
export type HttpStatusError = Error & {
  httpStatusCode?: number
  retryAfterMs?: number
  retryable?: boolean
}

const RETRYABLE_NET_ERROR =
  /net::ERR_(CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_(RESET|CLOSED|ABORTED|REFUSED|TIMED_OUT)|EMPTY_RESPONSE|NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NAME_NOT_RESOLVED|SOCKET_NOT_CONNECTED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b/
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
  return (
    RETRYABLE_NET_ERROR.test(error.message) || error.message.includes('without network activity')
  )
}
