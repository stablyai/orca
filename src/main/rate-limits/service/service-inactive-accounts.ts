import { fetchManagedAccountUsage } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { makeClaudeUsageResult } from '../claude-usage-result'
import { RateLimitServicePolling } from './service-polling'
import { INACTIVE_CODEX_PROBE_STAGGER_MS, INACTIVE_FETCH_DEBOUNCE_MS } from './service-types'
import { delayUnlessAborted } from '../../../shared/abort-aware-delay'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../shared/rate-limit-types'

export abstract class RateLimitServiceInactiveAccounts extends RateLimitServicePolling {
  protected override afterBackgroundFetch(): void {
    if (!this.pollInactiveClaude) {
      return
    }
    void this.fetchInactiveClaudeAccountsOnOpen()
  }

  async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
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
    console.info(`[claude-usage] inactive fetch start n=${accounts.length}`)
    if (accounts.length === 0) {
      console.info('[claude-usage] inactive fetch done n=0 ok=0 failed=0')
      return
    }
    const fetchGeneration = this.inactiveClaudeAccountsGeneration
    const controller = this.beginFetchCycle()
    const signal = controller.signal
    let ok = 0
    let failed = 0

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
            this.inactiveClaudeFetching.delete(account.id)
            if (!this.isCurrentInactiveClaudeAccount(account.id)) {
              this.inactiveClaudeCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          if (this.noteInactiveClaudeFetch(account.id, fresh)) {
            ok += 1
          } else {
            failed += 1
          }
        } catch (error) {
          // Isolate each account's Keychain/network failure so siblings continue.
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            this.inactiveClaudeCache.delete(account.id)
          } else {
            this.noteInactiveClaudeFetch(
              account.id,
              makeClaudeUsageResult('error', 'Claude usage is unavailable.', {
                failureKind: inactiveClaudeThrownFailureKind(error)
              })
            )
            failed += 1
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
      console.info(
        `[claude-usage] inactive fetch done n=${accounts.length} ok=${ok} failed=${failed}`
      )
    }
  }

  private noteInactiveClaudeFetch(accountId: string, fresh: ProviderRateLimits): boolean {
    const stored = this.applyStalePolicy(fresh, this.inactiveClaudeCache.get(accountId) ?? null)
    this.inactiveClaudeCache.set(accountId, stored)
    if (stored.status === 'ok') {
      return true
    }
    const kind = stored.usageMetadata?.failureKind ?? 'unknown'
    const http = stored.usageMetadata?.httpStatus
    console.info(
      `[claude-usage] inactive fetch account=${accountId} failure=${kind}${http ? ` http=${http}` : ''}`
    )
    return false
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

function inactiveClaudeThrownFailureKind(error: unknown): UsageRateLimitFailureKind {
  const message = error instanceof Error ? error.message : ''
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 36 || /interaction is not allowed|keychain/i.test(message)) {
    return 'keychain-unavailable'
  }
  return 'unknown'
}
