import { RateLimitServiceFetchControl } from './service-fetch-control'
import {
  MAX_ACTIVE_FAILURE_STREAK,
  RATE_LIMITED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  type ActiveRateLimitProvider,
  type ProviderRateLimits
} from './service-types'

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

    const previousHasData = Boolean(
      previous?.session ||
      previous?.weekly ||
      previous?.fableWeekly ||
      previous?.monthly ||
      (previous?.buckets && previous.buckets.length > 0)
    )

    // No previous data to fall back on
    if (!previous || !previousHasData) {
      return fresh
    }

    // Previous data is too old — don't show stale data
    const staleThresholdMs =
      fresh.usageMetadata?.failureKind === 'rate-limited'
        ? RATE_LIMITED_STALE_THRESHOLD_MS
        : STALE_THRESHOLD_MS
    if (Date.now() - previous.updatedAt > staleThresholdMs) {
      return fresh
    }

    // Why: keep showing a recent snapshot through repeated transient failures until it ages out, so the bar doesn't flap to empty.
    return {
      ...previous,
      error: fresh.error,
      status: 'error',
      usageMetadata: {
        ...previous.usageMetadata,
        ...fresh.usageMetadata,
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
    provider:
      | 'claude'
      | 'codex'
      | 'gemini'
      | 'opencode-go'
      | 'kimi'
      | 'minimax'
      | 'grok'
      | 'antigravity'
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
