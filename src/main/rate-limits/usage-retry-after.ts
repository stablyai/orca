import { parseRetryAfterHeaderMs } from '../../shared/retry-after-header'

// Cap corrupt/hostile headers so they cannot suppress polling indefinitely.
const MAX_USAGE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export function parseUsageRetryAfterMs(value: string | null, nowMs?: number): number | null {
  return parseRetryAfterHeaderMs(value, MAX_USAGE_RETRY_AFTER_MS, nowMs)
}
