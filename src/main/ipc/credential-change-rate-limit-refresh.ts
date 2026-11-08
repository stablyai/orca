import type { RateLimitService } from '../rate-limits/service'

/** Refresh usage in the background so callers can return persisted credential status even if refresh fails. */
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
