import { fetchManagedAccountUsage } from '../claude-fetcher'
import { makeClaudeUsageResult } from '../claude-usage-result'
import { RateLimitServicePolling } from './service-polling'
import { INACTIVE_FETCH_DEBOUNCE_MS, type ActiveClaudeUsageAccount } from './service-types'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../shared/rate-limit-types'

export abstract class RateLimitServiceSelectedClaudeUsage extends RateLimitServicePolling {
  /** Why not the inactive cache: a live statusline for this account must keep landing on `state.claude`. */
  protected async fetchSelectedClaudeUsage(
    account: ActiveClaudeUsageAccount,
    signal: AbortSignal
  ): Promise<'ok' | 'failed' | 'skipped'> {
    const generation = this.claudeFetchGeneration
    const accountId = account.id
    try {
      const fresh = await fetchManagedAccountUsage(account, {
        allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
        networkProxySettings: this.networkProxySettingsResolver?.(),
        signal
      })
      return this.applySelectedClaudeUsage(accountId, generation, signal, fresh)
    } catch (error) {
      if (
        signal.aborted ||
        generation !== this.claudeFetchGeneration ||
        this.activeClaudeUsageAccountResolver?.()?.id !== accountId ||
        this.isLiveClaudeUsageFresh(this.state.claude)
      ) {
        return 'skipped'
      }
      return this.applySelectedClaudeUsage(
        accountId,
        generation,
        signal,
        makeClaudeUsageResult('error', 'Claude usage is unavailable.', {
          failureKind: inactiveClaudeThrownFailureKind(error)
        })
      )
    }
  }

  protected selectedHostUsageAccount(inactive: readonly { id: string }[]): {
    account: ActiveClaudeUsageAccount | null
    omission: { reason: string; accountId: string } | null
  } {
    const active = this.activeClaudeUsageAccountResolver?.() ?? null
    if (!active || inactive.some((account) => account.id === active.id)) {
      return { account: null, omission: null }
    }
    if (this.isLiveClaudeUsageFresh(this.state.claude)) {
      return { account: null, omission: { reason: 'live-session', accountId: active.id } }
    }
    if (this.isRetryAfterActive(this.state.claude)) {
      return { account: null, omission: { reason: 'retry-after', accountId: active.id } }
    }
    if (this.claudeOAuthReadingAlreadyCovers(active)) {
      return { account: null, omission: { reason: 'already-read', accountId: active.id } }
    }
    return { account: active, omission: null }
  }

  private applySelectedClaudeUsage(
    accountId: string,
    generation: number,
    signal: AbortSignal,
    fresh: ProviderRateLimits
  ): 'ok' | 'failed' | 'skipped' {
    if (
      signal.aborted ||
      generation !== this.claudeFetchGeneration ||
      this.activeClaudeUsageAccountResolver?.()?.id !== accountId ||
      this.isLiveClaudeUsageFresh(this.state.claude)
    ) {
      return 'skipped'
    }
    const applied = this.resolveClaudeFetchApply(fresh, this.state.claude)
    this.updateState({ ...this.state, claude: applied })
    if (applied.status === 'ok') {
      return 'ok'
    }
    const kind = applied.usageMetadata?.failureKind ?? 'unknown'
    const http = applied.usageMetadata?.httpStatus
    console.info(
      `[claude-usage] inactive fetch account=${accountId} failure=${kind}${http ? ` http=${http}` : ''}`
    )
    return 'failed'
  }

  private claudeOAuthReadingAlreadyCovers(account: ActiveClaudeUsageAccount): boolean {
    const limits = this.state.claude
    const provenance = limits?.usageMetadata?.authProvenance
    const covers = account.runsOnSystemDefault
      ? provenance === 'system'
      : provenance === `profile:${account.id}` || !!provenance?.startsWith(`profile:${account.id}:`)
    const recent =
      this.lastClaudeCheckCompletedAt !== null &&
      Date.now() - this.lastClaudeCheckCompletedAt < INACTIVE_FETCH_DEBOUNCE_MS
    return covers && recent && limits?.usageMetadata?.source !== 'live-session'
  }
}

export function inactiveClaudeThrownFailureKind(error: unknown): UsageRateLimitFailureKind {
  const message = error instanceof Error ? error.message : ''
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 36 || /interaction is not allowed|keychain/i.test(message)) {
    return 'keychain-unavailable'
  }
  return 'unknown'
}
