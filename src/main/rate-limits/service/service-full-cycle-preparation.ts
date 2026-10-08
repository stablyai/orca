import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchGeminiRateLimits } from '../gemini-usage-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import { fetchCursorRateLimits } from '../cursor-fetcher'
import { readCursorAuthSession } from '../cursor-auth'
import { fetchZcodeRateLimits } from '../zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from '../antigravity-usage-fetcher'
import { antigravityUsageDisabledSnapshot } from '../antigravity-usage-snapshot'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../../shared/zcode-plan-sites'
import { fetchMiniMaxRateLimits } from '../minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../opencode-go-usage-source-selection'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { SettledProviderResult } from './service-sibling-provider-result'
import type {
  ClaudeRuntimeAuthPreparation,
  InternalRateLimitState,
  NormalizedClaudeAccountSelectionTarget,
  NormalizedCodexAccountSelectionTarget,
  ProviderRateLimits
} from './service-types'

export type FetchAllCyclePrepared = {
  claudeTarget: NormalizedClaudeAccountSelectionTarget
  claudeGeneration: number
  claudeAuthPreparation: ClaudeRuntimeAuthPreparation | undefined
  claudeProvenance: string
  codexTarget: NormalizedCodexAccountSelectionTarget
  previousState: InternalRateLimitState
  codexFetchGated: boolean
  codexStateBeforeFetch: ProviderRateLimits | null
  codexProvenance: string | null
  codexGeneration: number
  opencodeConfigChanged: boolean
  opencodeGeneration: number
  miniMaxConfigChanged: boolean
  miniMaxGeneration: number
  zcodeConfigChanged: boolean
  zcodeGeneration: number
  claudeFetchGated: boolean
  results: [
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>
  ]
  grokResultPromise: Promise<SettledProviderResult>
  cursorResultPromise: Promise<SettledProviderResult>
  zcodeResultPromise: Promise<SettledProviderResult>
  antigravityResultPromise: Promise<SettledProviderResult>
}

export abstract class RateLimitServiceFullCyclePreparation extends RateLimitServiceFetchPolicy {
  protected async prepareFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<FetchAllCyclePrepared | null> {
    if (signal.aborted) {
      return null
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return null
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    const previousState = this.state
    // Why: a skipped Codex poll must not stop the other providers' cycle, so gate
    // only the Codex slot instead of returning early (#STA-4422).
    const codexHome = this.resolveCodexHome(codexTarget)
    const codexFetchGated = codexHome.skip
    const codexHomePath = codexHome.homePath
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const codexGeneration = this.codexFetchGeneration
    const openCodeGoConfig = this.resolveOpenCodeGoConfig()
    const cookie = openCodeGoConfig.sessionCookie
    const workspaceIdOverride = openCodeGoConfig.workspaceIdOverride
    const openCodeGoApiKey = openCodeGoConfig.apiKey
    const openCodeGoApiKeyError = openCodeGoConfig.apiKeyError
    const openCodeGoApiKeyReadSkipped = openCodeGoConfig.apiKeyReadSkipped
    const miniMaxConfigResult = this.resolveMiniMaxConfig()
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const geminiCliOAuthEnabled = this.geminiCliOAuthEnabledResolver?.() ?? false
    // Why: getState() is hot (renderer pushes + mobile snapshots); keep Grok's sync auth-file probe on fetch cycles instead.
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    // Discard stale data on config change — it belongs to a different session/workspace.
    // Digest, not the key: this string only has to change when the account does.
    const apiKeyFingerprint = openCodeGoApiKey
      ? createHash('sha256').update(openCodeGoApiKey).digest('hex')
      : ''
    const currentConfigHash = `${cookie}|${workspaceIdOverride}|${apiKeyFingerprint}|${openCodeGoApiKeyError ?? ''}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    if (opencodeConfigChanged) {
      this.lastOpencodeConfigHash = currentConfigHash
      this.opencodeFetchGeneration += 1
    }
    const opencodeGeneration = this.opencodeFetchGeneration

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxEndpoint}|${miniMaxApiKey}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged = currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    if (miniMaxConfigChanged) {
      this.lastMiniMaxConfigHash = currentMiniMaxConfigHash
      this.minimaxFetchGeneration += 1
    }
    const miniMaxGeneration = this.minimaxFetchGeneration

    const antigravityUsageEnabled = this.antigravityUsageEnabledResolver?.() ?? true

    const zcodePlanConfigResult = this.resolveZcodePlanConfig()
    const zcodePlanApiKey = zcodePlanConfigResult.config.apiKey
    // Why digest, not the key: this string only has to change when the credential does.
    const currentZcodeConfigHash = zcodePlanApiKey
      ? `${zcodePlanConfigResult.config.site}|${createHash('sha256').update(zcodePlanApiKey).digest('hex')}`
      : (zcodePlanConfigResult.error ?? '')
    const zcodeConfigChanged = currentZcodeConfigHash !== this.lastZcodeConfigHash
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
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude'),
      // Why: a gated Codex cycle makes no attempt; a "fetching" chip would never settle.
      codex: codexFetchGated
        ? codexStateBeforeFetch
        : this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: this.withFetchingStatus(previousState.gemini, 'gemini'),
      opencodeGo: opencodeConfigChanged
        ? this.withFetchingStatus(null, 'opencode-go')
        : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go'),
      kimi: this.withFetchingStatus(previousState.kimi, 'kimi'),
      antigravity: antigravityUsageEnabled
        ? this.withFetchingStatus(previousState.antigravity, 'antigravity')
        : (previousState.antigravity ?? antigravityUsageDisabledSnapshot()),
      minimax: miniMaxConfigChanged
        ? this.withFetchingStatus(null, 'minimax')
        : this.withFetchingStatus(previousState.minimax, 'minimax'),
      grok: this.withFetchingStatus(previousState.grok, 'grok'),
      cursor: this.withFetchingStatus(previousState.cursor, 'cursor'),
      zcode: zcodeConfigChanged
        ? this.withFetchingStatus(null, 'zcode')
        : this.withFetchingStatus(previousState.zcode, 'zcode')
    })

    // Why its own promise: the keychain read and the desktop state.vscdb read
    // (on its worker thread) are both async and must not delay other providers.
    const cursorResultPromise = readCursorAuthSession()
      .then((authReadResult) => {
        this.cursorAuthConfigured = authReadResult.status === 'ok'
        return fetchCursorRateLimits({ signal, authReadResult })
      })
      .then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason) => ({ status: 'rejected', reason }) as const
      )

    const zcodeResultPromise = (
      zcodePlanConfigResult.error
        ? Promise.resolve(this.getZcodePlanCredentialError(zcodePlanConfigResult.error))
        : fetchZcodeRateLimits({ signal, planCredential: zcodePlanCredential })
    ).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    // Hidden meters avoid the CLI spawn; the separate promise keeps other providers responsive.
    const antigravityResultPromise = (
      antigravityUsageEnabled
        ? fetchAntigravityRateLimits({ signal })
        : Promise.resolve(previousState.antigravity ?? antigravityUsageDisabledSnapshot())
    ).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    const grokResultPromise = fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    // Why: skip automated Claude fetches while a Retry-After window is open or a live session feed is fresher than the OAuth poll would be.
    const claudeFetchGated =
      !options?.force && this.shouldSkipAutomatedClaudeFetch(previousState.claude)

    const [claudeResult, codexResult, geminiResult, opencodeGoResult, kimiResult, miniMaxResult] =
      await Promise.allSettled([
        claudeFetchGated
          ? Promise.resolve(previousState.claude as ProviderRateLimits)
          : fetchClaudeRateLimits({
              authPreparation: claudeAuthPreparation,
              allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
              allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal
            }),
        codexFetchGated
          ? Promise.resolve(previousState.codex as ProviderRateLimits)
          : (missingWslCodexHome ??
            fetchCodexRateLimits({
              codexHomePath,
              signal
            })),
        fetchGeminiRateLimits(geminiCliOAuthEnabled),
        fetchOpenCodeGoUsage({
          settingsApiKey: openCodeGoApiKey,
          // Why here: the key can also come from the environment or OpenCode's
          // own store, so presence is only known once the fetch resolves it.
          onApiKeyResolved: (resolution) => {
            // Why: a credential change mid-fetch bumps the generation; its stale presence must not win.
            if (opencodeGeneration !== this.opencodeFetchGeneration) {
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
          signal
        }),
        this.fetchKimiWithResolvedHome(),
        miniMaxConfigResult.error
          ? Promise.resolve(this.getMiniMaxCredentialError(miniMaxConfigResult.error))
          : fetchMiniMaxRateLimits({
              cookie: miniMaxCookie,
              groupId: miniMaxGroupId,
              models: miniMaxModels,
              endpointMode: miniMaxEndpoint,
              apiKey: miniMaxApiKey
            })
      ])

    if (signal.aborted) {
      return null
    }
    // Why: the decrypt error only replaces a result with no usage and no diagnosis of its own; a real cookie error stays visible.
    if (
      openCodeGoApiKeyError &&
      opencodeGoResult.status === 'fulfilled' &&
      opencodeGoResult.value.status === 'unavailable'
    ) {
      opencodeGoResult.value = {
        ...opencodeGoResult.value,
        error: openCodeGoApiKeyError,
        status: 'error'
      }
    }
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
