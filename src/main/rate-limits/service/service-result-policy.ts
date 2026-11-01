import type { RateLimitWindow } from '../../../shared/rate-limit-types'
import { RateLimitServiceFetchControl } from './service-fetch-control'
import {
  LONG_STALE_THRESHOLD_MS,
  MAX_ACTIVE_FAILURE_STREAK,
  STALE_THRESHOLD_MS,
  type ActiveRateLimitProvider,
  type ProviderRateLimits
} from './service-types'

export function hasUsageWindows(limits: ProviderRateLimits): boolean {
  return Boolean(
    limits.session ||
    limits.weekly ||
    limits.fableWeekly ||
    limits.monthly ||
    (limits.buckets && limits.buckets.length > 0)
  )
}

// Why: a window past its reset no longer describes the account, and 0% would hide use on another device.
export function withoutResetWindows(limits: ProviderRateLimits, now: number): ProviderRateLimits {
  const isCurrent = (window: RateLimitWindow): boolean =>
    typeof window.resetsAt !== 'number' || window.resetsAt > now
  const current = (window: RateLimitWindow | null | undefined): RateLimitWindow | null =>
    window && isCurrent(window) ? window : null
  return {
    ...limits,
    session: current(limits.session),
    weekly: current(limits.weekly),
    ...(limits.fableWeekly ? { fableWeekly: current(limits.fableWeekly) } : {}),
    ...(limits.monthly ? { monthly: current(limits.monthly) } : {}),
    ...(limits.buckets ? { buckets: limits.buckets.filter(isCurrent) } : {})
  }
}

export abstract class RateLimitServiceResultPolicy extends RateLimitServiceFetchControl {
  protected applyStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    if (fresh.status === 'ok') {
      return {
        ...fresh,
        usageMetadata: {
          ...fresh.usageMetadata,
          lastSuccessfulSource:
            fresh.usageMetadata?.source ?? fresh.usageMetadata?.lastSuccessfulSource
        }
      }
    }

    // Explicit unavailability clears stale usage, including removed settings.
    if (fresh.status === 'unavailable') {
      return fresh
    }

    if (!previous) {
      return fresh
    }

    const failureKind = fresh.usageMetadata?.failureKind
    // Only Claude's lapsed token renews itself when its CLI next runs; others may be a real expiry.
    const staleThresholdMs =
      failureKind === 'rate-limited' ||
      (failureKind === 'stale-token' && fresh.provider === 'claude')
        ? LONG_STALE_THRESHOLD_MS
        : STALE_THRESHOLD_MS
    const now = Date.now()
    if (now - previous.updatedAt > staleThresholdMs) {
      return fresh
    }

    const current = withoutResetWindows(previous, now)
    if (!hasUsageWindows(current)) {
      return fresh
    }

    // Preserve recent display through transient errors until stale expiry, avoiding empty-bar flashes.
    return {
      ...current,
      error: fresh.error,
      status: 'error',
      usageMetadata: {
        ...previous.usageMetadata,
        ...fresh.usageMetadata,
        // Error kind belongs to this failure, not an older snapshot.
        failureKind: fresh.usageMetadata?.failureKind,
        lastSuccessfulSource:
          previous.usageMetadata?.lastSuccessfulSource ?? previous.usageMetadata?.source
      }
    }
  }

  protected trackActiveFailureStreak(
    provider: ActiveRateLimitProvider,
    fresh: ProviderRateLimits
  ): void {
    if (fresh.status === 'error') {
      this.activeFailureStreakByProvider[provider] = Math.min(
        this.activeFailureStreakByProvider[provider] + 1,
        MAX_ACTIVE_FAILURE_STREAK
      )
      return
    }
    if (fresh.status === 'ok' || fresh.status === 'unavailable') {
      this.activeFailureStreakByProvider[provider] = 0
    }
  }

  protected withFetchingStatus(
    current: ProviderRateLimits | null,
    provider: ActiveRateLimitProvider
  ): ProviderRateLimits {
    if (!current) {
      return {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null,
        status: 'fetching'
      }
    }
    // Keep settled chips visible during background retries to avoid loading/error flashes.
    if (current.status === 'ok' || current.status === 'error' || current.status === 'unavailable') {
      return current
    }
    return { ...current, status: 'fetching' }
  }
}
