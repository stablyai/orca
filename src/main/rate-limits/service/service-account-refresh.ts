import { consumeCodexRateLimitResetCredit } from '../codex-fetcher'
import { RateLimitServiceInactiveAccounts } from './service-inactive-accounts'
import {
  normalizeCodexAccountSelectionTarget,
  normalizeClaudeAccountSelectionTarget,
  type CodexAccountSelectionTarget,
  type ClaudeAccountSelectionTarget,
  type RateLimitRuntimeTarget,
  type RateLimitState,
  type CodexRateLimitResetResult
} from './service-types'

export abstract class RateLimitServiceAccountRefresh extends RateLimitServiceInactiveAccounts {
  async refresh(): Promise<RateLimitState> {
    // Why: this user-directed refresh must bypass the poll throttle, else the click can no-op after wake/focus and feel broken.
    await this.fetchAll({ force: true })
    return this.getState()
  }

  async refreshIfStale(): Promise<RateLimitState> {
    // Why: reconnecting mobile subscribers need fresh backgrounded-desktop data, but replaying a subscription must not queue another forced fetch.
    const plan = this.getActiveWindowRefreshPlan(Date.now())
    await this.runActiveWindowRefreshPlan(plan)
    return this.getState()
  }

  async refreshGrok(): Promise<RateLimitState> {
    await this.fetchGrokOnly({ force: true })
    return this.getState()
  }

  invalidateMiniMaxCredentialState(): void {
    this.minimaxFetchGeneration += 1
    // Why: saving/forgetting the cookie can race an in-flight fetch; clear the visible snapshot before any old-cookie result returns.
    this.updateState({
      ...this.state,
      minimax: this.withFetchingStatus(null, 'minimax')
    })
  }

  async refreshForCodexAccountChange(
    outgoingAccountId?: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<RateLimitState> {
    const nextTarget = normalizeCodexAccountSelectionTarget(target)
    // Why: weekly-only plans report no session window, so gating on session alone
    // dropped their snapshot and left the switcher's inline bars empty.
    if (
      outgoingAccountId &&
      (this.state.codex?.session || this.state.codex?.weekly) &&
      this.isSameCodexTarget(this.codexFetchTarget, nextTarget)
    ) {
      this.inactiveCodexCache.set(outgoingAccountId, this.state.codex)
    }
    this.codexFetchTarget = nextTarget
    this.codexFetchGeneration += 1
    // Why: a new account/target starts with a clean retry schedule.
    this.activeFailureStreakByProvider.codex = 0
    this.inactiveCodexAccountsGeneration += 1
    this.pruneInactiveCodexState()
    // Why: the switch must NOT reset the inactive-fetch debounce — re-probing
    // every inactive account per switch spawns codex in each credential home
    // and endangers rotating refresh tokens; the switcher shows the cached
    // snapshot (seeded above for the outgoing account) until the debounce ends.
    // Why: clear the old Codex view immediately, else the previous account's limits show under the newly selected identity until the next poll.
    this.updateState({
      ...this.state,
      codex: this.withFetchingStatus(null, 'codex')
    })
    await this.fetchCodexOnly({ force: true })
    return this.getState()
  }

  async refreshCodexForTarget(target?: CodexAccountSelectionTarget): Promise<RateLimitState> {
    const nextTarget = normalizeCodexAccountSelectionTarget(target)
    const targetChanged = !this.isSameCodexTarget(this.codexFetchTarget, nextTarget)
    this.codexFetchTarget = nextTarget
    this.codexFetchGeneration += 1
    this.activeFailureStreakByProvider.codex = 0
    this.updateState({
      ...this.state,
      codex: this.withFetchingStatus(targetChanged ? null : this.state.codex, 'codex')
    })
    await this.fetchCodexOnly({ force: true })
    return this.getState()
  }

  async consumeCodexRateLimitResetCredit(options: {
    idempotencyKey: string
    target: RateLimitRuntimeTarget
    codexHomePath: string | null
  }): Promise<CodexRateLimitResetResult> {
    const codexTarget = normalizeCodexAccountSelectionTarget(options.target)
    const codexHomePath = options.codexHomePath
    const scopedStateBeforeReset = this.getState()
    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    if (missingWslCodexHome) {
      if (this.isSameCodexTarget(this.codexFetchTarget, codexTarget)) {
        await this.fetchCodexOnly({ force: true })
      }
      throw new Error(missingWslCodexHome.error ?? 'Codex home unavailable')
    }
    try {
      const outcome = await consumeCodexRateLimitResetCredit({
        codexHomePath,
        idempotencyKey: options.idempotencyKey
      })
      const state = await this.fetchCodexResetResultState(
        codexTarget,
        codexHomePath,
        scopedStateBeforeReset
      )
      return { outcome, state }
    } catch (error) {
      if (this.isSameCodexTarget(this.codexFetchTarget, codexTarget)) {
        await this.fetchCodexOnly({ force: true })
      }
      throw error
    }
  }

  async refreshForClaudeAccountChange(
    outgoingAccountId?: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<RateLimitState> {
    const nextTarget = normalizeClaudeAccountSelectionTarget(target)
    // Why: snapshot the outgoing account's usage before clearing so the switcher's inline bars can show last-known data immediately.
    if (
      outgoingAccountId &&
      this.state.claude?.session &&
      this.isSameClaudeTarget(this.claudeFetchTarget, nextTarget)
    ) {
      this.inactiveClaudeCache.set(outgoingAccountId, this.state.claude)
    }
    this.claudeFetchTarget = nextTarget
    this.inactiveClaudeAccountsGeneration += 1
    this.pruneInactiveClaudeState()
    this.claudeFetchGeneration += 1
    // Why: a new account/target starts with a clean retry schedule.
    this.activeFailureStreakByProvider.claude = 0
    // Why: statusline posts from the outgoing account's sessions must not land on the incoming account's bar mid-switch.
    this.lastClaudeAuthSnapshot = null
    this.lastInactiveClaudeFetchAt = 0
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(null, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }

  async refreshClaudeForTarget(target?: ClaudeAccountSelectionTarget): Promise<RateLimitState> {
    const nextTarget = normalizeClaudeAccountSelectionTarget(target)
    const targetChanged = !this.isSameClaudeTarget(this.claudeFetchTarget, nextTarget)
    this.claudeFetchTarget = nextTarget
    this.claudeFetchGeneration += 1
    this.activeFailureStreakByProvider.claude = 0
    if (targetChanged) {
      // Why: statusline posts from the outgoing target's sessions must not land on the incoming target's bar mid-switch.
      this.lastClaudeAuthSnapshot = null
    }
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(targetChanged ? null : this.state.claude, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }

  async refreshAfterClaudeLivePtysDrained(): Promise<void> {
    // Why: "Waiting for Claude session" can only recover once no live claude
    // owns the credentials. Refetch on the last PTY exit instead of leaving
    // the stale terminal error up until the failure backoff elapses.
    if (!this.state.claude?.usageMetadata?.deferredByLiveClaudeSession) {
      return
    }
    this.activeFailureStreakByProvider.claude = 0
    await this.fetchClaudeOnly({ force: true })
  }
}
