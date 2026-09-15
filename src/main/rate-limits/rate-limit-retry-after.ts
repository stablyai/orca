// Why: a corrupt/hostile Retry-After must not gate usage refreshes for days.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
  }
  // Why: Retry-After may also be an HTTP-date (RFC 9110).
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) {
    return null
  }
  const delta = dateMs - Date.now()
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
}
