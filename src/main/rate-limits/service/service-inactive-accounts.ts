import { fetchManagedAccountUsage } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { RateLimitServicePolling } from './service-polling'
import { INACTIVE_CODEX_PROBE_STAGGER_MS, INACTIVE_FETCH_DEBOUNCE_MS } from './service-types'
import type { ProviderUsageRequest } from './service-usage-requests'
import { delayUnlessAborted } from '../../../shared/abort-aware-delay'

export abstract class RateLimitServiceInactiveAccounts extends RateLimitServicePolling {
  private inactiveClaudeUsageRequest: ProviderUsageRequest | null = null
  async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
    if (!this.isUsageRequestEnabled('claude')) {
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
    const cycleController = this.beginFetchCycle()
    const request = this.beginProviderUsageRequest('claude', cycleController.signal)
    this.inactiveClaudeUsageRequest = request
    const ownsFetching = (): boolean => this.inactiveClaudeUsageRequest === request
    const controller = request.controller
    const signal = controller.signal

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
          if (ownsFetching()) {
            this.inactiveClaudeFetching.delete(account.id)
          }
          if (!this.isCurrentInactiveClaudeAccount(account.id)) {
            this.inactiveClaudeCache.delete(account.id)
          }
          this.pushToRenderer()
          continue
        }
        try {
          const fresh = await fetchManagedAccountUsage(account, {
            allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
            networkProxySettings: this.networkProxySettingsResolver?.(),
            signal
          })
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            if (ownsFetching()) {
              this.inactiveClaudeFetching.delete(account.id)
            }
            if (!this.isCurrentInactiveClaudeAccount(account.id)) {
              this.inactiveClaudeCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          const cached = this.inactiveClaudeCache.get(account.id) ?? null
          this.inactiveClaudeCache.set(account.id, this.applyStalePolicy(fresh, cached))
        } catch {
          // Why: per-account try/catch keeps one Keychain/network error from aborting the remaining accounts in the batch.
          if (!this.isCurrentInactiveClaudeAccount(account.id)) {
            this.inactiveClaudeCache.delete(account.id)
          }
        }
        if (ownsFetching()) {
          this.inactiveClaudeFetching.delete(account.id)
        }
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.inactiveClaudeAccountsGeneration) {
        this.lastInactiveClaudeFetchAt = Date.now()
      }
    } finally {
      if (ownsFetching()) {
        this.inactiveClaudeUsageRequest = null
      }
      request.finish()
      this.finishFetchCycle(cycleController)
    }
  }

  async fetchInactiveCodexAccountsOnOpen(): Promise<void> {
    if (!this.isUsageRequestEnabled('codex')) {
      return
    }
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
    // Why: account switching can activate a previewed account while its usage fetch is still in flight; ignore stale results.
    const fetchGeneration = this.inactiveCodexAccountsGeneration
    const cycleController = this.beginFetchCycle()
    const request = this.beginProviderUsageRequest('codex', cycleController.signal)
    const controller = request.controller
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
        if (staggerNextProbe) {
          await delayUnlessAborted(INACTIVE_CODEX_PROBE_STAGGER_MS, signal)
          // Why: the account set can change while the stagger delay runs.
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
        const home = account.resolveHome()
        if (home.kind === 'skip') {
          continue
        }
        staggerNextProbe = true
        this.inactiveCodexFetching.add(account.id)
        this.pushToRenderer()
        try {
          // Why: point fetchCodexRateLimits at the managed home directly, avoiding materializing credentials into the shared runtime location.
          const fresh = await fetchCodexRateLimits({
            codexHomePath: home.managedHomePath,
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
          // Why: per-account try/catch prevents one failure from aborting the batch.
          if (!this.isCurrentInactiveCodexAccount(account.id)) {
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
      request.finish()
      this.finishFetchCycle(cycleController)
    }
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
    // Why: clear only this account, not the generation — bumping it would discard sibling fetches still in flight and their fresh results.
    this.inactiveCodexCache.delete(accountId)
    this.inactiveCodexFetching.delete(accountId)
    this.pushToRenderer()
  }
}
