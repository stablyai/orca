import type { RateLimitService } from '../rate-limits/service'

/**
 * Drops a provider's stale usage, then refreshes in the background.
 * Why fire-and-forget: callers return the persisted credential status immediately; a failed refresh only logs.
 */
export function refreshAfterCredentialChange<T extends Pick<RateLimitService, 'refresh'>>(
  rateLimits: T | null,
  invalidate: (rateLimits: T) => void,
  failureLogMessage: string
): void {
  if (!rateLimits) {
    return
  }
  invalidate(rateLimits)
  void rateLimits.refresh().catch((error: unknown) => {
    console.error(failureLogMessage, error)
  })
}
