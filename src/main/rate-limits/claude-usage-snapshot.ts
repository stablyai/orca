import type { ProviderRateLimits } from '../../shared/rate-limit-types'

// A null slot means loading to readers; a disabled meter must settle instead.
export function claudeUsageDisabledSnapshot(now: number = Date.now()): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: now,
    error: null,
    status: 'idle'
  }
}
