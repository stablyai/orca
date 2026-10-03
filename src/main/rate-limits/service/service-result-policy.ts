import type { UsageRateLimitFailureKind } from '../../../shared/rate-limit-types'
import {
  expireClaudeUsageWindows,
  hasClaudeUsageWindows,
  nextClaudeUsageWindowReset
} from '../claude-usage-window-expiry'
import { RateLimitServiceFetchControl } from './service-fetch-control'
import {
  MAX_ACTIVE_FAILURE_STREAK,
  RATE_LIMITED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  type ActiveRateLimitProvider,
  type ProviderRateLimits
} from './service-types'

const LOGIN_REQUIRED_FAILURE_KINDS: ReadonlySet<UsageRateLimitFailureKind> = new Set([
  'missing-credentials'
])

export abstract class RateLimitServiceResultPolicy extends RateLimitServiceFetchControl {
  private inactiveClaudeExpiryTimer: ReturnType<typeof setTimeout> | null = null

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

  /**
   * Stale policy for saved-but-inactive Claude accounts. Nobody is using the account, so its
   * last-known windows stay valid until each one resets, not for the active bar's 30 minutes.
   */
  protected applyInactiveClaudeStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    const failureKind = fresh.usageMetadata?.failureKind
    // Why: an unclassified failure (e.g. "No credentials") may be a lost login, so it keeps the 30-minute policy.
    if (fresh.status === 'ok' || fresh.status === 'unavailable' || !previous || !failureKind) {
      return this.applyStalePolicy(fresh, previous)
    }
    // Why: a login that needs the user is not transient; old bars would hide the "sign in" row for days.
    if (LOGIN_REQUIRED_FAILURE_KINDS.has(failureKind)) {
      return fresh
    }
    const kept = expireClaudeUsageWindows(previous)
    if (!hasClaudeUsageWindows(kept)) {
      return fresh
    }
    return {
      ...kept,
      error: fresh.error,
      status: 'error',
      usageMetadata: {
        ...kept.usageMetadata,
        ...fresh.usageMetadata,
        lastSuccessfulSource: kept.usageMetadata?.lastSuccessfulSource ?? kept.usageMetadata?.source
      }
    }
  }

  /**
   * Why: the renderer only sees a reset window as unknown when state is published, and
   * background polling stays quiet while the window is unfocused; publish once at the next reset.
   */
  protected scheduleInactiveClaudeExpiryPush(): void {
    this.clearInactiveClaudeExpiryPush()
    const now = Date.now()
    let nextReset: number | null = null
    for (const limits of this.inactiveClaudeCache.values()) {
      const reset = nextClaudeUsageWindowReset(limits, now)
      if (reset !== null && (nextReset === null || reset < nextReset)) {
        nextReset = reset
      }
    }
    if (nextReset === null) {
      return
    }
    this.inactiveClaudeExpiryTimer = setTimeout(
      () => {
        this.inactiveClaudeExpiryTimer = null
        this.pushToRenderer()
        this.scheduleInactiveClaudeExpiryPush()
      },
      Math.max(1_000, nextReset - now + 1_000)
    )
    this.inactiveClaudeExpiryTimer.unref?.()
  }

  protected clearInactiveClaudeExpiryPush(): void {
    if (this.inactiveClaudeExpiryTimer) {
      clearTimeout(this.inactiveClaudeExpiryTimer)
      this.inactiveClaudeExpiryTimer = null
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
