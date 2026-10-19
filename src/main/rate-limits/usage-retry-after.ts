import { parseRetryAfterHeaderMs } from '../../shared/retry-after-header'

// Why: a corrupt/hostile Retry-After must not gate usage refreshes for days.
const MAX_USAGE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export function parseUsageRetryAfterMs(value: string | null, nowMs?: number): number | null {
  return parseRetryAfterHeaderMs(value, MAX_USAGE_RETRY_AFTER_MS, nowMs)
}
