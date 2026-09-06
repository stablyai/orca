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

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

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
    // Why: these fetches only power in-app UI; skip polling when hidden/minimized/unfocused to save CLI/API budget (refresh on activate).
    if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
      return false
    }
    return this.mainWindow.isFocused()
  }

  protected getActiveProviderState(): ActiveProviderState[] {
    // Why: key by provider so a new provider is compile-forced an entry — a missing one silently never recovers from a startup error.
    const byProvider: Record<ActiveRateLimitProvider, ProviderRateLimits | null> = {
      claude: this.state.claude,
      codex: this.state.codex,
      gemini: this.state.gemini,
      'opencode-go': this.state.opencodeGo,
      kimi: this.state.kimi,
      minimax: this.state.minimax,
      grok: this.state.grok,
      antigravity: this.state.antigravity
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
        if (now - limits.updatedAt >= MIN_REFETCH_MS) {
          return { kind: 'full' }
        }
        continue
      }
      // Why: a failed startup read is not fresh data; keep it eligible for activation recovery, throttled per provider.
      if (limits.status === 'error') {
        // Why: the server told us when to come back (Retry-After); retrying earlier burns the endpoint's budget and keeps the 429 alive.
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
      // Why: a full fetch retries failing providers too; restart their retry clocks so the individual failure lane doesn't fire ahead of backoff.
      // Why: gated on !isFetching — the fetchAll below no-ops mid-flight, so don't consume the retry throttle for free.
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

    // Why: an in-flight fetch will refresh these; skip without consuming the per-provider retry throttle so the next activation retries.
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

    // Why: recover partial failures of dedicated-fetch providers without re-reading healthy providers still inside their debounce.
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
