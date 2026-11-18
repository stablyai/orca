import {
  lookupBackoffDelayMs,
  LOOKUP_BACKOFF_MAX_MS,
  MAX_BRANCH_MAP_ENTRIES
} from './hosted-review-refresh-pacing'

/** Failure escalation outlives answer invalidation and includes lookup deadlines (#11532/P1-D). */

const MAX_BACKOFF_ENTRIES = MAX_BRANCH_MAP_ENTRIES

const failureBackoff = new Map<string, { until: number; failures: number }>()

export function backoffUntil(key: string): number | null {
  // Keep failure count after window expiry or retries would never escalate.
  const entry = failureBackoff.get(key)
  return entry !== undefined && entry.until > Date.now() ? entry.until : null
}

export function noteFailure(key: string): void {
  const now = Date.now()
  for (const [candidate, entry] of failureBackoff) {
    // Forget only after a full max window of inactivity so ordinary retries preserve escalation.
    if (now - entry.until > LOOKUP_BACKOFF_MAX_MS) {
      failureBackoff.delete(candidate)
    }
  }
  const failures = (failureBackoff.get(key)?.failures ?? 0) + 1
  failureBackoff.delete(key)
  failureBackoff.set(key, { until: now + lookupBackoffDelayMs(failures), failures })
  while (failureBackoff.size > MAX_BACKOFF_ENTRIES) {
    const oldest = failureBackoff.keys().next().value
    if (oldest === undefined) {
      break
    }
    failureBackoff.delete(oldest)
  }
}

/** A lookup answered, so the branch starts its next escalation from the base. */
export function clearFailures(key: string): void {
  failureBackoff.delete(key)
}

export function dropFailuresWithPrefix(prefix: string): void {
  for (const key of failureBackoff.keys()) {
    if (key.startsWith(prefix)) {
      failureBackoff.delete(key)
    }
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewLookupBackoffForTests(): void {
  failureBackoff.clear()
}
