import type { ProviderRateLimits } from '../../shared/rate-limit-types'

/** A Codex reading that produced no window, carrying why. Never `ok`: an empty reading
 *  settled as success is what the stale policy writes over the last real usage. */
export function failedCodexRateLimitReading(
  error: string,
  status: 'error' | 'unavailable' = 'error'
): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

export function abortedCodexRateLimitResult(): ProviderRateLimits {
  return failedCodexRateLimitReading('Rate-limit fetch aborted')
}
