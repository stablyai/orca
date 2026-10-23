import { settleProviderUsageRequest } from './service-sibling-provider-result'
import type { UsageRequestProvider } from '../../../shared/usage-request-policy'
import type { ProviderUsageRequest } from './service-usage-requests'
import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchGeminiRateLimits } from '../gemini-usage-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import { fetchCursorRateLimits } from '../cursor-fetcher'
import { readCursorAuthSession } from '../cursor-auth'
import { fetchZcodeRateLimits } from '../zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from '../antigravity-usage-fetcher'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../../shared/zcode-plan-sites'
import { fetchMiniMaxRateLimits } from '../minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../opencode-go-usage-source-selection'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { ProviderRateLimits } from './service-types'
import type { FetchAllCyclePrepared } from './service-full-cycle-types'
import { applyOpenCodeGoApiKeyError } from './service-opencode-go-result'

export abstract class RateLimitServiceFullCyclePreparation extends RateLimitServiceFetchPolicy {
  protected async prepareFetchAllCycle(
    signal: AbortSignal,
    options: { force?: boolean } | undefined,
    requests: Record<UsageRequestProvider, ProviderUsageRequest>
  ): Promise<FetchAllCyclePrepared | null> {
    if (signal.aborted) {
      return null
    }
    const canFetch = (provider: UsageRequestProvider): boolean =>
      this.isProviderUsageRequestCurrent(requests[provider])
    const providerSignal = (provider: UsageRequestProvider): AbortSignal =>
      requests[provider].controller.signal
    const placeholder = (provider: UsageRequestProvider): Promise<ProviderRateLimits> =>
      Promise.resolve(this.providerUsagePlaceholder(provider))
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = canFetch('claude')
      ? await this.claudeAuthPreparationResolver?.(claudeTarget, providerSignal('claude')).catch(
          (error: unknown) => {
            if (!providerSignal('claude').aborted) {
              throw error
            }
            return undefined
          }
        )
      : undefined
    if (signal.aborted) {
      return null
    }
    if (canFetch('claude')) {
      this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    }
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    // Why: capture before the resolver await; a reset during it bumps the generation and this cycle's result is stale.
    const codexGeneration = this.codexFetchGeneration
    const previousState = this.state
    // Why: a skipped Codex poll must not stop the other providers' cycle, so gate
    // only the Codex slot instead of returning early (#STA-4422).
    const codexHome = canFetch('codex')
      ? await this.resolveCodexHome(codexTarget, providerSignal('codex'))
      : { skip: true, homePath: null }
    const codexFetchGated = codexHome.skip || !canFetch('codex')
    const codexHomePath = codexHome.homePath
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const openCodeGoConfig = this.resolveOpenCodeGoConfig(requests['opencode-go'])
    const cookie = openCodeGoConfig.sessionCookie
    const workspaceIdOverride = openCodeGoConfig.workspaceIdOverride
    const openCodeGoApiKey = openCodeGoConfig.apiKey
    const openCodeGoApiKeyError = openCodeGoConfig.apiKeyError
    const openCodeGoApiKeyReadSkipped = openCodeGoConfig.apiKeyReadSkipped
    const miniMaxConfigResult = this.resolveMiniMaxConfig(requests.minimax)
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const geminiCliOAuthEnabled = this.geminiCliOAuthEnabledResolver?.() ?? false
    // Why: getState() is hot (renderer pushes + mobile snapshots); keep Grok's sync auth-file probe on fetch cycles instead.
    const grokAuthReadResult = canFetch('grok') ? readGrokAuthSession() : undefined
    if (grokAuthReadResult) {
      this.grokAuthConfigured = grokAuthReadResult.status === 'ok'
    }

    // Discard stale data on config change — it belongs to a different session/workspace.
    // Digest, not the key: this string only has to change when the account does.
    const apiKeyFingerprint = openCodeGoApiKey
      ? createHash('sha256').update(openCodeGoApiKey).digest('hex')
      : ''
    const currentConfigHash = `${cookie}|${workspaceIdOverride}|${apiKeyFingerprint}|${openCodeGoApiKeyError ?? ''}`
    const opencodeConfigChanged =
      canFetch('opencode-go') && currentConfigHash !== this.lastOpencodeConfigHash
    if (opencodeConfigChanged) {
      this.lastOpencodeConfigHash = currentConfigHash
      this.opencodeFetchGeneration += 1
    }
    const opencodeGeneration = this.opencodeFetchGeneration

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxEndpoint}|${miniMaxApiKey}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged =
      canFetch('minimax') && currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    if (miniMaxConfigChanged) {
      this.lastMiniMaxConfigHash = currentMiniMaxConfigHash
      this.minimaxFetchGeneration += 1
    }
    const miniMaxGeneration = this.minimaxFetchGeneration

    const antigravityUsageEnabled = canFetch('antigravity')

    const zcodePlanConfigResult = this.resolveZcodePlanConfig(requests.zcode)
    const zcodePlanApiKey = zcodePlanConfigResult.config.apiKey
    // Why digest, not the key: this string only has to change when the credential does.
    const currentZcodeConfigHash = zcodePlanApiKey
      ? `${zcodePlanConfigResult.config.site}|${createHash('sha256').update(zcodePlanApiKey).digest('hex')}`
      : (zcodePlanConfigResult.error ?? '')
    const zcodeConfigChanged =
      canFetch('zcode') && currentZcodeConfigHash !== this.lastZcodeConfigHash
    if (zcodeConfigChanged) {
      this.lastZcodeConfigHash = currentZcodeConfigHash
      this.zcodeFetchGeneration += 1
    }
    const zcodeGeneration = this.zcodeFetchGeneration
    const zcodePlanCredential = zcodePlanApiKey
      ? {
          apiKey: zcodePlanApiKey,
          baseUrl: ZCODE_PLAN_SITE_BASE_URLS[zcodePlanConfigResult.config.site]
        }
      : null

    // Mark all providers fetching while keeping previous data visible (Codex is cleared separately on account change).
    this.updateState({
      ...this.state,
      claude: canFetch('claude')
        ? this.withFetchingStatus(this.state.claude, 'claude')
        : this.state.claude,
      // Why: a gated Codex cycle makes no attempt; a "fetching" chip would never settle.
      codex: !canFetch('codex')
        ? this.state.codex
        : codexFetchGated
          ? codexStateBeforeFetch
          : this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: canFetch('gemini')
        ? this.withFetchingStatus(this.state.gemini, 'gemini')
        : this.state.gemini,
      opencodeGo: !canFetch('opencode-go')
        ? this.state.opencodeGo
        : opencodeConfigChanged
          ? this.withFetchingStatus(null, 'opencode-go')
          : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go'),
      kimi: canFetch('kimi') ? this.withFetchingStatus(this.state.kimi, 'kimi') : this.state.kimi,
      antigravity: antigravityUsageEnabled
        ? this.withFetchingStatus(previousState.antigravity, 'antigravity')
        : this.state.antigravity,
      minimax: !canFetch('minimax')
        ? this.state.minimax
        : miniMaxConfigChanged
          ? this.withFetchingStatus(null, 'minimax')
          : this.withFetchingStatus(previousState.minimax, 'minimax'),
      grok: canFetch('grok') ? this.withFetchingStatus(this.state.grok, 'grok') : this.state.grok,
      cursor: canFetch('cursor')
        ? this.withFetchingStatus(this.state.cursor, 'cursor')
        : this.state.cursor,
      zcode: !canFetch('zcode')
        ? this.state.zcode
        : zcodeConfigChanged
          ? this.withFetchingStatus(null, 'zcode')
          : this.withFetchingStatus(previousState.zcode, 'zcode')
    })

    // Why its own promise: the keychain read and the desktop state.vscdb read
    // (on its worker thread) are both async and must not delay other providers.
    const cursorResultPromise = settleProviderUsageRequest(
      canFetch('cursor')
        ? readCursorAuthSession({ signal: providerSignal('cursor') }).then((authReadResult) => {
            if (!canFetch('cursor')) {
              return this.providerUsagePlaceholder('cursor')
            }
            this.cursorAuthConfigured = authReadResult.status === 'ok'
            return fetchCursorRateLimits({ signal: providerSignal('cursor'), authReadResult })
          })
        : placeholder('cursor')
    )

    const zcodeResultPromise = settleProviderUsageRequest(
      !canFetch('zcode')
        ? placeholder('zcode')
        : zcodePlanConfigResult.error
          ? Promise.resolve(this.getZcodePlanCredentialError(zcodePlanConfigResult.error))
          : fetchZcodeRateLimits({
              signal: providerSignal('zcode'),
              planCredential: zcodePlanCredential
            })
    )

    // Hidden meters avoid the CLI spawn; the separate promise keeps other providers responsive.
    const antigravityResultPromise = settleProviderUsageRequest(
      antigravityUsageEnabled
        ? fetchAntigravityRateLimits({ signal: providerSignal('antigravity') })
        : placeholder('antigravity')
    )

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    const grokResultPromise = settleProviderUsageRequest(
      canFetch('grok')
        ? fetchGrokRateLimits({
            signal: providerSignal('grok'),
            authReadResult: grokAuthReadResult
          })
        : placeholder('grok')
    )

    // Why: skip automated Claude fetches while a Retry-After window is open or a live session feed is fresher than the OAuth poll would be.
    const claudeFetchGated =
      !canFetch('claude') ||
      (!options?.force && this.shouldSkipAutomatedClaudeFetch(previousState.claude))

    const [claudeResult, codexResult, geminiResult, opencodeGoResult, kimiResult, miniMaxResult] =
      await Promise.allSettled([
        claudeFetchGated
          ? placeholder('claude')
          : fetchClaudeRateLimits({
              authPreparation: claudeAuthPreparation,
              allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
              allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal: providerSignal('claude')
            }),
        codexFetchGated
          ? placeholder('codex')
          : (missingWslCodexHome ??
            fetchCodexRateLimits({
              codexHomePath,
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal: providerSignal('codex')
            })),
        canFetch('gemini')
          ? fetchGeminiRateLimits(geminiCliOAuthEnabled, providerSignal('gemini'))
          : placeholder('gemini'),
        !canFetch('opencode-go')
          ? placeholder('opencode-go')
          : fetchOpenCodeGoUsage({
              settingsApiKey: openCodeGoApiKey,
              // Why here: the key can also come from the environment or OpenCode's
              // own store, so presence is only known once the fetch resolves it.
              onApiKeyResolved: (resolution) => {
                // Why: a credential change mid-fetch bumps the generation; its stale presence must not win.
                if (
                  !canFetch('opencode-go') ||
                  opencodeGeneration !== this.opencodeFetchGeneration
                ) {
                  return
                }
                // An undecryptable or briefly unreadable saved key still counts, so the bar stays up.
                this.openCodeGoApiKeyConfigured =
                  resolution.status === 'found' ||
                  openCodeGoApiKeyError !== null ||
                  openCodeGoApiKeyReadSkipped
              },
              cookie,
              workspaceIdOverride: workspaceIdOverride || undefined,
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal: providerSignal('opencode-go')
            }),
        canFetch('kimi')
          ? this.fetchKimiWithResolvedHome(providerSignal('kimi'))
          : placeholder('kimi'),
        !canFetch('minimax')
          ? placeholder('minimax')
          : miniMaxConfigResult.error
            ? Promise.resolve(this.getMiniMaxCredentialError(miniMaxConfigResult.error))
            : fetchMiniMaxRateLimits({
                cookie: miniMaxCookie,
                groupId: miniMaxGroupId,
                models: miniMaxModels,
                endpointMode: miniMaxEndpoint,
                apiKey: miniMaxApiKey,
                signal: providerSignal('minimax')
              })
      ])

    if (signal.aborted) {
      return null
    }
    applyOpenCodeGoApiKeyError(opencodeGoResult, openCodeGoApiKeyError)
    return {
      claudeTarget,
      claudeGeneration,
      claudeAuthPreparation,
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
    }
  }
}
