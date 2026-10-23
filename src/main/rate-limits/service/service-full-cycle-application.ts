import type { UsageRequestProvider } from '../../../shared/usage-request-policy'
import type { ProviderUsageRequest } from './service-usage-requests'
import { RateLimitServiceFullCyclePreparation } from './service-full-cycle-preparation'
import { isZcodeUsageCredentialCurrent } from '../zcode-usage-credentials'
import { settleSiblingProviderResult } from './service-sibling-provider-result'
import type { ProviderRateLimits } from './service-types'

export abstract class RateLimitServiceFullCycleApplication extends RateLimitServiceFullCyclePreparation {
  protected async runFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    const requests = this.beginAllProviderUsageRequests(signal)
    try {
      await this.applyFetchAllCycle(signal, options, requests)
    } finally {
      for (const request of Object.values(requests)) {
        request.finish()
      }
    }
  }

  private async applyFetchAllCycle(
    signal: AbortSignal,
    options: { force?: boolean } | undefined,
    requests: Record<UsageRequestProvider, ProviderUsageRequest>
  ): Promise<void> {
    const canApply = (provider: UsageRequestProvider): boolean =>
      this.isProviderUsageRequestCurrent(requests[provider])
    const prepared = await this.prepareFetchAllCycle(signal, options, requests)
    if (!prepared) {
      return
    }
    const {
      claudeTarget,
      claudeGeneration,
      claudeProvenance,
      codexTarget,
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      codexProvenance,
      codexGeneration,
      opencodeConfigChanged,
      opencodeGeneration,
      miniMaxConfigChanged,
      miniMaxGeneration,
      zcodeConfigChanged,
      zcodeGeneration,
      claudeFetchGated,
      results: [
        claudeResult,
        codexResult,
        geminiResult,
        opencodeGoResult,
        kimiResult,
        miniMaxResult
      ],
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    } = prepared
    if (signal.aborted) {
      return
    }

    const claude =
      claudeResult.status === 'fulfilled'
        ? claudeResult.value
        : ({
            provider: 'claude',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              claudeResult.reason instanceof Error ? claudeResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const codex =
      codexResult.status === 'fulfilled'
        ? codexResult.value
        : ({
            provider: 'codex',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              codexResult.reason instanceof Error ? codexResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const gemini =
      geminiResult.status === 'fulfilled'
        ? geminiResult.value
        : ({
            provider: 'gemini',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              geminiResult.reason instanceof Error ? geminiResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const opencodeGo =
      opencodeGoResult.status === 'fulfilled'
        ? opencodeGoResult.value
        : ({
            provider: 'opencode-go',
            session: null,
            weekly: null,
            monthly: null,
            updatedAt: Date.now(),
            error:
              opencodeGoResult.reason instanceof Error
                ? opencodeGoResult.reason.message
                : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const kimi =
      kimiResult.status === 'fulfilled'
        ? kimiResult.value
        : ({
            provider: 'kimi',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: kimiResult.reason instanceof Error ? kimiResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const miniMax =
      miniMaxResult.status === 'fulfilled'
        ? miniMaxResult.value
        : ({
            provider: 'minimax',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              miniMaxResult.reason instanceof Error
                ? miniMaxResult.reason.message
                : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const latestCodexHome = canApply('codex')
      ? await this.resolveCodexHome(codexTarget, requests.codex.controller.signal)
      : { skip: true, homePath: null }
    const latestClaudeAuthPreparation = canApply('claude')
      ? await this.claudeAuthPreparationResolver?.(
          claudeTarget,
          requests.claude.controller.signal
        ).catch((error: unknown) => {
          if (!requests.claude.controller.signal.aborted) {
            throw error
          }
          return undefined
        })
      : undefined
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    // Why: a finishing skip has no provenance, so an in-flight result must never be
    // applied as though the target had become the system default (#STA-4422).
    const shouldApplyCodex =
      canApply('codex') &&
      !codexFetchGated &&
      !latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration &&
      codexProvenance === this.getCodexProvenance(codexTarget, latestCodexHome.homePath)
    const codexBecameUnavailable =
      canApply('codex') &&
      !codexFetchGated &&
      latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration
    // Why: a gated cycle made no Claude attempt; applying its passthrough result would grow the failure streak and reset stale-policy clocks for free.
    const shouldApplyClaude =
      canApply('claude') &&
      !claudeFetchGated &&
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    const shouldApplyOpencode =
      canApply('opencode-go') && opencodeGeneration === this.opencodeFetchGeneration
    const shouldApplyMiniMax =
      canApply('minimax') && miniMaxGeneration === this.minimaxFetchGeneration

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claude)
    }
    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    if (canApply('gemini')) {
      this.trackActiveFailureStreak('gemini', gemini)
    }
    if (shouldApplyOpencode) {
      this.trackActiveFailureStreak('opencode-go', opencodeGo)
    }
    if (canApply('kimi')) {
      this.trackActiveFailureStreak('kimi', kimi)
    }
    if (shouldApplyMiniMax) {
      this.trackActiveFailureStreak('minimax', miniMax)
    }

    // Why: apply a Codex result only when provenance and generation still match, else a raced in-flight fetch overwrites the new account.
    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.resolveClaudeFetchApply(claude, previousState.claude)
        : this.state.claude,
      codex: shouldApplyCodex
        ? this.applyStalePolicy(codex, previousState.codex)
        : codexBecameUnavailable
          ? codexStateBeforeFetch
          : this.state.codex,
      gemini: canApply('gemini')
        ? this.applyStalePolicy(gemini, previousState.gemini)
        : this.state.gemini,
      opencodeGo: shouldApplyOpencode
        ? opencodeConfigChanged
          ? opencodeGo
          : this.applyStalePolicy(opencodeGo, previousState.opencodeGo)
        : this.state.opencodeGo,
      kimi: canApply('kimi') ? this.applyStalePolicy(kimi, previousState.kimi) : this.state.kimi,
      minimax: shouldApplyMiniMax
        ? miniMaxConfigChanged
          ? miniMax
          : this.applyStalePolicy(miniMax, previousState.minimax)
        : this.state.minimax
    })

    const [grokSettled, cursorSettled, zcodeSettled, antigravitySettled] = await Promise.all([
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    ])
    if (signal.aborted) {
      return
    }
    const grok = settleSiblingProviderResult('grok', grokSettled)
    const cursor = settleSiblingProviderResult('cursor', cursorSettled)
    const settledZcode = settleSiblingProviderResult('zcode', zcodeSettled)
    const zcode =
      !canApply('zcode') || isZcodeUsageCredentialCurrent(settledZcode)
        ? settledZcode
        : {
            ...settledZcode,
            status: 'unavailable' as const,
            session: null,
            weekly: null,
            monthly: null,
            error: 'ZCode Coding Plan account changed during refresh'
          }
    const shouldApplyZcode = canApply('zcode') && zcodeGeneration === this.zcodeFetchGeneration
    const antigravity = settleSiblingProviderResult('antigravity', antigravitySettled)
    // Why: the stale policy keeps a recent snapshot through a failed refresh, but
    // a snapshot belonging to a different Cursor account must not survive the
    // switch — the Accounts pane would name the new account beside the old
    // account's figures. Only a known-and-changed identity clears it, so an
    // errored refresh that reports no account still keeps its own last reading.
    const previousCursorAccount = previousState.cursor?.usageMetadata?.authProvenance
    const cursorAccount = cursor.usageMetadata?.authProvenance
    const cursorAccountChanged =
      previousCursorAccount !== undefined &&
      cursorAccount !== undefined &&
      previousCursorAccount !== cursorAccount
    const previousZcodeAccount = previousState.zcode?.usageMetadata?.authProvenance
    const zcodeAccount = zcode.usageMetadata?.authProvenance
    const sameZcodeAccount =
      previousZcodeAccount !== undefined &&
      zcodeAccount !== undefined &&
      previousZcodeAccount === zcodeAccount
    if (canApply('grok')) {
      this.trackActiveFailureStreak('grok', grok)
    }
    if (canApply('cursor')) {
      this.trackActiveFailureStreak('cursor', cursor)
    }
    if (shouldApplyZcode) {
      this.trackActiveFailureStreak('zcode', zcode)
    }
    if (canApply('antigravity')) {
      this.trackActiveFailureStreak('antigravity', antigravity)
    }
    this.updateState({
      ...this.state,
      grok: canApply('grok') ? this.applyStalePolicy(grok, previousState.grok) : this.state.grok,
      cursor: !canApply('cursor')
        ? this.state.cursor
        : cursorAccountChanged
          ? cursor
          : this.applyStalePolicy(cursor, previousState.cursor),
      zcode: !shouldApplyZcode
        ? this.state.zcode
        : zcodeConfigChanged
          ? zcode
          : zcode.status === 'error' && !sameZcodeAccount
            ? zcode
            : this.applyStalePolicy(zcode, previousState.zcode),
      antigravity: canApply('antigravity')
        ? this.applyStalePolicy(antigravity, previousState.antigravity)
        : this.state.antigravity
    })
  }
}
