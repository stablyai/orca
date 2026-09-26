import { RateLimitServiceFullCycleApplication } from './service-full-cycle-application'
import { fetchClaudeRateLimits, fetchConsoleBalance } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import type { ProviderRateLimits } from './service-types'

export abstract class RateLimitServiceProviderCycles extends RateLimitServiceFullCycleApplication {
  protected async runFetchCodexOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const codexTarget = this.codexFetchTarget
    const codexGeneration = this.codexFetchGeneration
    const codexHome = this.resolveCodexHome(codexTarget)
    // Why: return before the "fetching" mark — a skipped cycle never settles it (#STA-4422).
    if (codexHome.skip) {
      if (
        codexGeneration === this.codexFetchGeneration &&
        this.state.codex?.status === 'fetching'
      ) {
        this.updateState({ ...this.state, codex: null })
      }
      return
    }
    const codexHomePath = codexHome.homePath
    const codexProvenance = this.getCodexProvenance(codexTarget, codexHomePath)
    const previousState = this.state

    this.updateState({
      ...previousState,
      codex: this.withFetchingStatus(previousState.codex, 'codex')
    })

    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    const codex = await (
      missingWslCodexHome
        ? Promise.resolve(missingWslCodexHome)
        : fetchCodexRateLimits({
            codexHomePath,
            allowPtyFallback: this.shouldAllowCodexPtyFallback(),
            signal
          })
    ).catch((err): ProviderRateLimits => ({
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    const latestCodexHome = this.resolveCodexHome(codexTarget)
    if (latestCodexHome.skip && codexGeneration === this.codexFetchGeneration) {
      this.updateState({
        ...this.state,
        codex: previousState.codex?.status === 'fetching' ? null : previousState.codex
      })
      return
    }
    const shouldApplyCodex =
      !latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration &&
      codexProvenance === this.getCodexProvenance(codexTarget, latestCodexHome.homePath)

    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    this.updateState({
      ...this.state,
      codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
    })
  }

  protected async runFetchClaudeOnlyCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    if (signal.aborted) {
      return
    }
    // Why: Claude OAuth usage and Console balance have independent credentials and
    // rate limits, so a live-session or Retry-After gate must not suppress balance.
    if (!options?.force && this.shouldSkipAutomatedClaudeFetch(this.state.claude)) {
      // Why: nothing to refresh without a Console credential; return as the plain gate would.
      if (!this.state.claude || !this.consoleCredentialResolver) {
        return
      }
      // Why: the balance resolves under the target/generation captured here; a
      // mid-flight account switch must not paint it onto the newly selected target.
      const gatedTarget = this.claudeFetchTarget
      const gatedGeneration = this.claudeFetchGeneration
      const applyConsoleUpdate = (
        update: Pick<ProviderRateLimits, 'consoleBalance' | 'consoleBalanceError'>
      ): void => {
        const latestClaude = this.state.claude
        if (
          latestClaude &&
          gatedGeneration === this.claudeFetchGeneration &&
          this.isSameClaudeTarget(gatedTarget, this.claudeFetchTarget)
        ) {
          this.updateState({
            ...this.state,
            claude: { ...latestClaude, ...update }
          })
        }
      }
      try {
        const apiKey = await this.consoleCredentialResolver()
        if (apiKey && !signal.aborted) {
          const balance = await fetchConsoleBalance(apiKey, undefined, signal)
          applyConsoleUpdate({ consoleBalance: balance, consoleBalanceError: undefined })
        } else if (!signal.aborted) {
          applyConsoleUpdate({ consoleBalance: undefined, consoleBalanceError: undefined })
        }
      } catch (error) {
        if (!signal.aborted) {
          applyConsoleUpdate({
            consoleBalance: undefined,
            consoleBalanceError: error instanceof Error ? error.message : 'Unknown error'
          })
        }
      }
      return
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const previousState = this.state

    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude')
    })

    const claude = await fetchClaudeRateLimits({
      authPreparation: claudeAuthPreparation,
      allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
      allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    }).catch((err): ProviderRateLimits => ({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    let claudeWithBalance = claude
    let consoleBalanceUpdate:
      | Pick<ProviderRateLimits, 'consoleBalance' | 'consoleBalanceError'>
      | undefined
    // Why: skip the balance fetch (and its await) when no Console credential is configured.
    if (this.consoleCredentialResolver) {
      try {
        const apiKey = await this.consoleCredentialResolver()
        if (apiKey && !signal.aborted) {
          const balance = await fetchConsoleBalance(apiKey, undefined, signal)
          consoleBalanceUpdate = { consoleBalance: balance, consoleBalanceError: undefined }
          claudeWithBalance = {
            ...claude,
            ...consoleBalanceUpdate
          }
        } else if (!signal.aborted) {
          consoleBalanceUpdate = { consoleBalance: undefined, consoleBalanceError: undefined }
        }
      } catch (error) {
        consoleBalanceUpdate = {
          consoleBalance: undefined,
          consoleBalanceError: error instanceof Error ? error.message : 'Unknown error'
        }
        claudeWithBalance = {
          ...claude,
          ...consoleBalanceUpdate
        }
      }
    }

    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const shouldApplyClaude =
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claudeWithBalance)
    }
    this.updateState({
      ...this.state,
      claude: (() => {
        // Why: a rejected cycle (account/target switched mid-flight) must leave the
        // newly selected target untouched — its stale console balance included.
        if (!shouldApplyClaude) {
          return this.state.claude
        }
        const resolvedClaude = this.resolveClaudeFetchApply(claudeWithBalance, previousState.claude)
        return consoleBalanceUpdate && resolvedClaude
          ? { ...resolvedClaude, ...consoleBalanceUpdate }
          : resolvedClaude
      })()
    })
  }

  protected async runFetchGrokOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const previousState = this.state
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    this.updateState({
      ...previousState,
      grok: this.withFetchingStatus(previousState.grok, 'grok')
    })

    const grok = await fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).catch((err): ProviderRateLimits => ({
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    this.trackActiveFailureStreak('grok', grok)
    this.updateState({
      ...this.state,
      grok: this.applyStalePolicy(grok, previousState.grok)
    })
  }
}
