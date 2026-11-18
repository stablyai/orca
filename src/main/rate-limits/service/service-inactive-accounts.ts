import { fetchInactiveClaudeAccountUsage } from '../providers/claude/claude-managed-account-usage'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { RateLimitServicePolling } from './service-polling'
import { INACTIVE_CODEX_PROBE_STAGGER_MS, INACTIVE_FETCH_DEBOUNCE_MS } from './service-types'
import { delayUnlessAborted } from '../../../shared/concurrency/abort-aware-delay'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export abstract class RateLimitServiceInactiveAccounts extends RateLimitServicePolling {
  async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
    if (!this.isClaudeOAuthUsageEnabled()) {
      return
    }
    if (Date.now() - this.lastInactiveClaudeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    this.pruneInactiveClaudeState()
    if (this.inactiveClaudeFetching.size > 0) {
      return
    }
    const accounts = (this.inactiveClaudeAccountsResolver?.() ?? []).filter(
      (account) => !this.isRetryAfterActive(this.inactiveClaudeCache.get(account.id) ?? null)
    )
    if (accounts.length === 0) {
      return
    }
    const fetchGeneration = this.inactiveClaudeAccountsGeneration
    const controller = this.beginFetchCycle()
    const signal = this.claudeUsageFetchSignal(controller.signal)
    const readsByHome = this.claudeReadsByHome()

    for (const account of accounts) {
      this.inactiveClaudeFetching.add(account.id)
    }
    this.pushToRenderer()

    try {
      for (const account of accounts) {
        if (
          signal.aborted ||
          fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
          !this.isCurrentInactiveClaudeAccount(account.id)
        ) {
          this.inactiveClaudeFetching.delete(account.id)
          if (!this.isCurrentInactiveClaudeAccount(account.id)) {
            this.inactiveClaudeCache.delete(account.id)
          }
          this.pushToRenderer()
          continue
        }
        try {
          const startedAt = Date.now()
          const fresh = await fetchInactiveClaudeAccountUsage(account, {
            allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
            networkProxySettings: this.networkProxySettingsResolver?.(),
            readsByHome,
            signal
          })
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            this.inactiveClaudeFetching.delete(account.id)
            if (!this.isCurrentInactiveClaudeAccount(account.id)) {
              this.inactiveClaudeCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          const cached = this.inactiveClaudeCache.get(account.id) ?? null
          if (
            !(cached?.usageMetadata?.source === 'live-session' && cached.updatedAt >= startedAt)
          ) {
            this.inactiveClaudeCache.set(account.id, this.applyStalePolicy(fresh, cached))
          }
        } catch {
          // Isolate each account's Keychain/network failure so siblings continue.
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            this.inactiveClaudeCache.delete(account.id)
          }
        }
        this.inactiveClaudeFetching.delete(account.id)
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.inactiveClaudeAccountsGeneration) {
        this.lastInactiveClaudeFetchAt = Date.now()
      }
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  async fetchInactiveCodexAccountsOnOpen(): Promise<void> {
    if (Date.now() - this.lastInactiveCodexFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    this.pruneInactiveCodexState()
    if (this.inactiveCodexFetchInFlight) {
      return
    }
    const accounts = this.inactiveCodexAccountsResolver?.() ?? []
    if (accounts.length === 0) {
      return
    }
    // Switching can activate a previewed account mid-fetch; ignore its stale preview result.
    const fetchGeneration = this.inactiveCodexAccountsGeneration
    const controller = this.beginFetchCycle()
    const signal = controller.signal
    this.inactiveCodexFetchInFlight = true

    let staggerNextProbe = false
    try {
      for (const account of accounts) {
        if (
          signal.aborted ||
          fetchGeneration !== this.inactiveCodexAccountsGeneration ||
          !this.isCurrentInactiveCodexAccount(account.id)
        ) {
          this.inactiveCodexFetching.delete(account.id)
          if (!this.isCurrentInactiveCodexAccount(account.id)) {
            this.inactiveCodexCache.delete(account.id)
          }
          this.pushToRenderer()
          continue
        }
        const active = this.state.codex
        const readingAccount = active?.usageMetadata?.readingAccount
        if (
          readingAccount?.accountId === account.id &&
          active &&
          readingAccount.runtime === account.readingAccount?.runtime &&
          readingAccount.wslDistro === account.readingAccount?.wslDistro &&
          Date.now() - active.updatedAt < INACTIVE_FETCH_DEBOUNCE_MS
        ) {
          this.inactiveCodexCache.set(account.id, active)
          continue
        }
        if (staggerNextProbe) {
          await delayUnlessAborted(INACTIVE_CODEX_PROBE_STAGGER_MS, signal)
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveCodexAccountsGeneration ||
            !this.isCurrentInactiveCodexAccount(account.id)
          ) {
            this.inactiveCodexFetching.delete(account.id)
            if (!this.isCurrentInactiveCodexAccount(account.id)) {
              this.inactiveCodexCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
        }
        const home = await account.resolveHome()
        if (home.kind === 'skip') {
          continue
        }
        staggerNextProbe = true
        this.inactiveCodexFetching.add(account.id)
        this.pushToRenderer()
        try {
          // Read the managed home directly; do not materialize credentials in the shared runtime.
          const fresh = await fetchCodexRateLimits({
            codexHomePath: home.managedHomePath,
            authSnapshot: home.authSnapshot,
            readingAccount: account.readingAccount,
            networkProxySettings: this.networkProxySettingsResolver?.(),
            signal
          })
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveCodexAccountsGeneration ||
            !this.isCurrentInactiveCodexAccount(account.id)
          ) {
            this.inactiveCodexFetching.delete(account.id)
            if (!this.isCurrentInactiveCodexAccount(account.id)) {
              this.inactiveCodexCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          const cached = this.inactiveCodexCache.get(account.id) ?? null
          this.inactiveCodexCache.set(account.id, this.applyStalePolicy(fresh, cached))
        } catch {
          // Isolate per-account failures so sibling previews continue.
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveCodexAccountsGeneration ||
            !this.isCurrentInactiveCodexAccount(account.id)
          ) {
            this.inactiveCodexCache.delete(account.id)
          }
        }
        this.inactiveCodexFetching.delete(account.id)
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.inactiveCodexAccountsGeneration) {
        this.lastInactiveCodexFetchAt = Date.now()
      }
    } finally {
      this.inactiveCodexFetchInFlight = false
      this.finishFetchCycle(controller)
    }
  }

  /** Unselected accounts on the selected login's home (System default, legacy accounts) reuse its reading. */
  private claudeReadsByHome(): Map<string, Promise<ProviderRateLimits>> {
    const reads = new Map<string, Promise<ProviderRateLimits>>()
    const active = this.state.claude
    const home = this.usageReadingAccounts.claude?.home
    // Why idle only: a running refresh keeps the old reading in state until it lands.
    if (!this.isFetching && home && (active?.status === 'ok' || active?.status === 'error')) {
      reads.set(home, Promise.resolve(active))
    }
    return reads
  }

  evictInactiveClaudeCache(accountId: string): void {
    this.inactiveClaudeAccountsGeneration += 1
    this.inactiveClaudeCache.delete(accountId)
    this.inactiveClaudeFetching.delete(accountId)
    this.pushToRenderer()
  }

  protected isCurrentInactiveClaudeAccount(accountId: string): boolean {
    return (this.inactiveClaudeAccountsResolver?.() ?? []).some(
      (account) => account.id === accountId
    )
  }

  protected isCurrentInactiveCodexAccount(accountId: string): boolean {
    return (this.inactiveCodexAccountsResolver?.() ?? []).some(
      (account) => account.id === accountId
    )
  }

  protected pruneInactiveClaudeState(): void {
    const currentIds = new Set(
      (this.inactiveClaudeAccountsResolver?.() ?? []).map((account) => account.id)
    )
    for (const accountId of this.inactiveClaudeCache.keys()) {
      if (!currentIds.has(accountId)) {
        this.inactiveClaudeCache.delete(accountId)
      }
    }
    for (const accountId of this.inactiveClaudeFetching) {
      if (!currentIds.has(accountId)) {
        this.inactiveClaudeFetching.delete(accountId)
      }
    }
  }

  protected pruneInactiveCodexState(): void {
    const currentIds = new Set(
      (this.inactiveCodexAccountsResolver?.() ?? []).map((account) => account.id)
    )
    for (const accountId of this.inactiveCodexCache.keys()) {
      if (!currentIds.has(accountId)) {
        this.inactiveCodexCache.delete(accountId)
      }
    }
    for (const accountId of this.inactiveCodexFetching) {
      if (!currentIds.has(accountId)) {
        this.inactiveCodexFetching.delete(accountId)
      }
    }
  }

  evictInactiveCodexCache(accountId: string): void {
    // Clear one account without invalidating sibling fetches/results.
    this.inactiveCodexCache.delete(accountId)
    this.inactiveCodexFetching.delete(accountId)
    this.pushToRenderer()
  }
}
