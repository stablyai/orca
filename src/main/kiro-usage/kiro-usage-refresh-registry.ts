import type { RateLimitService } from '../rate-limits/service'
import { KiroUsageBackgroundRefresh } from './kiro-usage-background-refresh'

// One refresher per service so the desktop status bar and a paired phone share
// a single in-flight read and a single freshness window, rather than each
// spawning its own ~10s kiro-cli call against the same account.
const refreshersByService = new WeakMap<RateLimitService, KiroUsageBackgroundRefresh>()

/** The one refresher for this service, created on first ask. */
export function getKiroUsageRefresh(rateLimits: RateLimitService): KiroUsageBackgroundRefresh {
  const existing = refreshersByService.get(rateLimits)
  if (existing) {
    return existing
  }
  const created = new KiroUsageBackgroundRefresh({
    store: {
      read: () => rateLimits.getKiroUsage(),
      write: (limits) => rateLimits.setKiroUsage(limits)
    }
  })
  refreshersByService.set(rateLimits, created)
  return created
}
