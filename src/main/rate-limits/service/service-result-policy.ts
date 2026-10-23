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
    // Fresh data is fine — use it
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

    // Explicitly unavailable (e.g. setting cleared): discard stale data so the UI shows the provider as disabled/unconfigured.
    if (fresh.status === 'unavailable') {
      return fresh
    }

    // No previous data to fall back on
    if (!previous) {
      return fresh
    }

    // Previous data is too old — don't show stale data
    const failureKind = fresh.usageMetadata?.failureKind
    // Why: only Claude's lapsed token renews itself when its CLI next runs; other providers' may be a real expiry.
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

    // Why: keep showing a recent snapshot through repeated transient failures until it ages out, so the bar doesn't flap to empty.
    return {
      ...current,
      error: fresh.error,
      status: 'error',
      usageMetadata: {
        ...previous.usageMetadata,
        ...fresh.usageMetadata,
        // Why: the kind describes this error; an earlier failure's kind must not relabel it.
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
    // Why: keep a settled chip visible during background refetch so a persistently failing provider doesn't flash "…" → error each cycle.
    if (current.status === 'ok' || current.status === 'error' || current.status === 'unavailable') {
      return current
    }
    return { ...current, status: 'fetching' }
  }
}
