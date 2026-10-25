import { RateLimitServiceFetchQueue } from './service-fetch-queue'
import {
  ACTIVE_FAILURE_REFETCH_MS,
  DEFERRED_STARTUP_ACTIVE_REFRESH_MS,
  INDIVIDUALLY_REFRESHABLE_PROVIDERS,
  MAX_ACTIVE_FAILURE_REFETCH_MS,
  MIN_REFETCH_MS,
  normalizePollingInterval,
  type ActiveProviderState,
  type ActiveRateLimitProvider,
  type ActiveWindowRefreshPlan,
  type ProviderRateLimits
} from './service-types'

export abstract class RateLimitServicePolling extends RateLimitServiceFetchQueue {
  setPollingInterval(ms: number): void {
    this.pollInterval = normalizePollingInterval(ms)
    if (this.timer) {
      this.stopTimer()
      this.startTimer()
    }
  }

  protected startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      if (!this.shouldBackgroundPoll()) {
        return
      }
      void this.fetchAll()
    }, this.pollInterval)
  }

  protected stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  protected scheduleDeferredStartupRefresh(): void {
    this.clearDeferredStartupRefresh()
    this.deferredStartupRefreshTimer = setTimeout(() => {
      this.deferredStartupRefreshTimer = null
      void this.refreshIfWindowActive()
    }, DEFERRED_STARTUP_ACTIVE_REFRESH_MS)
  }

  protected clearDeferredStartupRefresh(): void {
    if (this.deferredStartupRefreshTimer) {
      clearTimeout(this.deferredStartupRefreshTimer)
      this.deferredStartupRefreshTimer = null
    }
  }

  protected shouldBackgroundPoll(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false
    }
    // UI-only polling pauses while inactive to save CLI/API budget; activation refreshes it.
    if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
      return false
    }
    return this.mainWindow.isFocused()
  }

  protected getActiveProviderState(): ActiveProviderState[] {
    // Exhaustive provider keys prevent new providers from silently missing startup-error recovery.
    const byProvider: Record<ActiveRateLimitProvider, ProviderRateLimits | null> = {
      claude: this.state.claude,
      codex: this.state.codex,
      gemini: this.state.gemini,
      'opencode-go': this.state.opencodeGo,
      kimi: this.state.kimi,
      minimax: this.state.minimax,
      grok: this.state.grok,
      antigravity: this.state.antigravity,
      cursor: this.state.cursor,
      zcode: this.state.zcode
    }
    return Object.entries(byProvider).map(([provider, limits]) => ({
      provider: provider as ActiveRateLimitProvider,
      limits
    }))
  }

  protected getActiveWindowRefreshPlan(now: number): ActiveWindowRefreshPlan {
    const retryableFailures: ActiveRateLimitProvider[] = []
    for (const { provider, limits } of this.getActiveProviderState()) {
      if (!limits || limits.status === 'idle' || limits.status === 'fetching') {
        return { kind: 'full' }
      }
      if (limits.status === 'ok' || limits.status === 'unavailable') {
        if (this.shouldSkipAutomatedFetch(provider, limits)) {
          continue
        }
        const checkedAt = provider === 'claude' ? this.lastClaudeCheckCompletedAt : limits.updatedAt
        if (checkedAt === null || now - checkedAt >= MIN_REFETCH_MS) {
          return { kind: 'full' }
        }
        continue
      }
      // Failed startup reads remain eligible for provider-throttled activation recovery.
      if (limits.status === 'error') {
        // Respect server Retry-After rather than spending budget and prolonging 429s.
        if (this.isRetryAfterActive(limits)) {
          continue
        }
        const lastRetryAt = this.lastActiveFailureRetryAtByProvider[provider]
        const throttleMs = INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)
          ? Math.min(
              ACTIVE_FAILURE_REFETCH_MS *
                2 ** Math.max(0, this.activeFailureStreakByProvider[provider] - 1),
              MAX_ACTIVE_FAILURE_REFETCH_MS
            )
          : MIN_REFETCH_MS
        if (now - lastRetryAt >= throttleMs) {
          retryableFailures.push(provider)
        }
      }
    }

    if (retryableFailures.length === 0) {
      return { kind: 'none' }
    }
    return { kind: 'providers', providers: retryableFailures }
  }

  protected async runActiveWindowRefreshPlan(plan: ActiveWindowRefreshPlan): Promise<void> {
    if (plan.kind === 'none') {
      return
    }
    if (plan.kind === 'full') {
      // Full fetches retry failures too; restart clocks only if one can start, never for an in-flight no-op.
      if (!this.isFetching) {
        const now = Date.now()
        for (const { provider, limits } of this.getActiveProviderState()) {
          if (limits?.status === 'error') {
            this.lastActiveFailureRetryAtByProvider[provider] = now
          }
        }
      }
      await this.fetchAll()
      return
    }

    // In-flight work already refreshes this data; preserve retry allowance for the next activation.
    if (this.isFetching) {
      return
    }

    const now = Date.now()
    for (const provider of plan.providers) {
      this.lastActiveFailureRetryAtByProvider[provider] = now
    }

    const canRefreshIndividually = plan.providers.every((provider) =>
      INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)
    )
    if (!canRefreshIndividually) {
      await this.fetchAll()
      return
    }

    // Dedicated cycles retry failing providers without rereading healthy debounced siblings.
    if (plan.providers.includes('claude')) {
      await this.fetchClaudeOnly()
    }
    if (plan.providers.includes('codex')) {
      await this.fetchCodexOnly()
    }
    if (plan.providers.includes('grok')) {
      await this.fetchGrokOnly()
    }
  }

  protected async refreshIfWindowActive(): Promise<void> {
    if (!this.shouldBackgroundPoll()) {
      return
    }
    const plan = this.getActiveWindowRefreshPlan(Date.now())
    await this.runActiveWindowRefreshPlan(plan)
  }
}
