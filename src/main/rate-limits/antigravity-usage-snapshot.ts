import type { ProviderRateLimits } from '../../shared/rate-limit-types'
// A null slot means loading to readers; a disabled meter must settle instead.
export function antigravityUsageDisabledSnapshot(now: number = Date.now()): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: null,
    status: 'idle'
  }
}
