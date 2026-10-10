import type { ProviderRateLimits } from '../../shared/rate-limit-types'
// A null slot means loading to readers; a hidden meter must settle instead.
export function museUsageDisabledSnapshot(now: number = Date.now()): ProviderRateLimits {
  return {
    provider: 'muse',
    session: null,
    weekly: null,
    updatedAt: now,
    error: null,
    status: 'idle'
  }
}
