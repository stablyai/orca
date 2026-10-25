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
    // User refresh must bypass recent poll/focus throttles.
    await this.fetchAll({ force: true })
    return this.getState()
  }

  async refreshIfStale(): Promise<RateLimitState> {
    // Reconnecting mobile needs fresh data, but subscription replay must not force redundant fetches.
    const plan = this.getActiveWindowRefreshPlan(Date.now())
    await this.runActiveWindowRefreshPlan(plan)
    return this.getState()
  }

  async refreshGrok(): Promise<RateLimitState> {
    await this.fetchGrokOnly({ force: true })
    return this.getState()
  }

  invalidateOpenCodeGoCredentialState(options: { apiKeyCleared?: boolean } = {}): void {
    this.opencodeFetchGeneration += 1
    // Store/env keys survive cookie changes; only clearing the saved override hides its presence.
    if (options.apiKeyCleared) {
      this.openCodeGoApiKeyConfigured = false
    }
    // Invalidate visible and in-flight usage when credentials change.
    this.updateState({
      ...this.state,
      opencodeGo: this.withFetchingStatus(null, 'opencode-go')
    })
  }

  invalidateMiniMaxCredentialState(): void {
    this.minimaxFetchGeneration += 1
    // Clear before an old-cookie fetch can return.
    this.updateState({
      ...this.state,
      minimax: this.withFetchingStatus(null, 'minimax')
    })
  }

  invalidateZcodeCredentialState(): void {
    this.zcodeFetchGeneration += 1
    // Clear before an old-key fetch can return.
    this.updateState({
      ...this.state,
      zcode: this.withFetchingStatus(null, 'zcode')
    })
  }

  async refreshForCodexAccountChange(
    outgoingAccountId?: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<RateLimitState> {
    const nextTarget = normalizeCodexAccountSelectionTarget(target)
    // Weekly-only plans still need outgoing switcher snapshots.
    if (
      outgoingAccountId &&
      (this.state.codex?.session || this.state.codex?.weekly) &&
      this.isSameCodexTarget(this.codexFetchTarget, nextTarget)
    ) {
      this.inactiveCodexCache.set(outgoingAccountId, this.state.codex)
    }
    this.codexFetchTarget = nextTarget
    this.codexFetchGeneration += 1
    this.activeFailureStreakByProvider.codex = 0
    this.inactiveCodexAccountsGeneration += 1
    this.pruneInactiveCodexState()
    // Preserve inactive debounce: probing every live credential home on each switch risks rotating tokens.
    // Clear active usage immediately so outgoing figures cannot appear under the new account.
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
        scopedStateBeforeReset,
        outcome
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
    // Seed outgoing switcher data before clearing the active snapshot.
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
    this.lastClaudeCheckCompletedAt = null
    this.activeFailureStreakByProvider.claude = 0
    // Outgoing statusline posts must not land on the incoming account during the switch.
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
    this.lastClaudeCheckCompletedAt = null
    this.activeFailureStreakByProvider.claude = 0
    if (targetChanged) {
      // Outgoing target posts must not land on the incoming target during the switch.
      this.lastClaudeAuthSnapshot = null
    }
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(targetChanged ? null : this.state.claude, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }
}
