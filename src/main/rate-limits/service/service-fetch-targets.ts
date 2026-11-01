import { RateLimitServiceResultPolicy } from './service-result-policy'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchKimiRateLimits } from '../kimi-fetcher'
import {
  isSystemDefaultClaudeAuth,
  type ClaudeRuntimeAuthPreparation,
  type CodexAccountSelectionTarget,
  type MiniMaxResolvedConfig,
  type ZcodePlanResolvedConfig,
  type OpenCodeGoResolvedConfig,
  type NormalizedCodexAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget,
  type ProviderRateLimits,
  type RateLimitState,
  toErrorMessage
} from './service-types'
import type { CodexRateLimitResetOutcome } from '../../../shared/rate-limit-types'
import { ApiKeyFileUnreadableError } from '../../credentials/api-key-file-unreadable-error'

const CODEX_RESET_REFRESH_RETRIES = 3
const CODEX_RESET_REFRESH_DELAY_MS = 250

function waitForCodexResetRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CODEX_RESET_REFRESH_DELAY_MS))
}

function codexResetUsageVisible(
  fresh: ProviderRateLimits,
  previous: ProviderRateLimits | null
): boolean {
  if (fresh.status !== 'ok') {
    return false
  }
  if (!previous) {
    return (fresh.session?.usedPercent ?? 0) <= 0 && (fresh.weekly?.usedPercent ?? 0) <= 0
  }
  const sessionImproved =
    fresh.session !== null &&
    (previous.session === null || fresh.session.usedPercent < previous.session.usedPercent)
  const weeklyImproved =
    fresh.weekly !== null &&
    (previous.weekly === null || fresh.weekly.usedPercent < previous.weekly.usedPercent)
  return sessionImproved || weeklyImproved
}

export abstract class RateLimitServiceFetchTargets extends RateLimitServiceResultPolicy {
  protected async resolveCodexHome(target?: CodexAccountSelectionTarget): Promise<{
    skip: boolean
    homePath: string | null
  }> {
    const resolution = await this.codexHomePathResolver?.(target)
    if (!resolution) {
      return { skip: false, homePath: null }
    }
    return resolution.kind === 'skip'
      ? { skip: true, homePath: null }
      : { skip: false, homePath: resolution.codexHomePath }
  }

  // WSL home resolution probes wsl.exe; chain it so other providers start immediately.
  protected fetchKimiWithResolvedHome(): Promise<ProviderRateLimits> {
    const pendingHome = this.kimiHomeResolver?.()
    return pendingHome
      ? pendingHome.then((home) => fetchKimiRateLimits({ home }))
      : fetchKimiRateLimits({ home: undefined })
  }

  protected isSameCodexTarget(
    left: NormalizedCodexAccountSelectionTarget,
    right: NormalizedCodexAccountSelectionTarget
  ): boolean {
    return left.runtime === right.runtime && left.wslDistro === right.wslDistro
  }

  protected isSameClaudeTarget(
    left: NormalizedClaudeAccountSelectionTarget,
    right: NormalizedClaudeAccountSelectionTarget
  ): boolean {
    return left.runtime === right.runtime && left.wslDistro === right.wslDistro
  }

  protected getCodexProvenance(
    target: NormalizedCodexAccountSelectionTarget,
    codexHomePath: string | null
  ): string {
    const targetKey = target.runtime === 'wsl' ? `wsl:${target.wslDistro ?? '__default__'}` : 'host'
    return codexHomePath ? `${targetKey}:managed:${codexHomePath}` : `${targetKey}:system`
  }

  protected getMissingWslCodexHomeResult(
    target: NormalizedCodexAccountSelectionTarget
  ): ProviderRateLimits | null {
    if (target.runtime !== 'wsl') {
      return null
    }
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: `WSL Codex home unavailable for ${target.wslDistro ?? 'default distro'}`,
      status: 'error'
    }
  }

  protected async fetchCodexResetResultState(
    target: NormalizedCodexAccountSelectionTarget,
    codexHomePath: string | null,
    stateBeforeReset: RateLimitState,
    outcome: CodexRateLimitResetOutcome
  ): Promise<RateLimitState> {
    let fresh: ProviderRateLimits = stateBeforeReset.codex ?? {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: 0,
      error: null,
      status: 'fetching'
    }
    for (
      let attempt = 0;
      attempt <= (outcome === 'reset' ? CODEX_RESET_REFRESH_RETRIES : 0);
      attempt += 1
    ) {
      if (attempt > 0) {
        await waitForCodexResetRefresh()
      }
      const controller = this.beginFetchCycle()
      try {
        fresh = await fetchCodexRateLimits({
          codexHomePath,
          networkProxySettings: this.networkProxySettingsResolver?.(),
          signal: controller.signal
        })
      } catch (error) {
        fresh = {
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: toErrorMessage(error),
          status: 'error'
        }
      } finally {
        this.finishFetchCycle(controller)
      }
      if (outcome !== 'reset' || codexResetUsageVisible(fresh, stateBeforeReset.codex)) {
        break
      }
    }

    const scopedCodex = this.applyStalePolicy(fresh, stateBeforeReset.codex)
    const currentCodexHome = await this.resolveCodexHome(target)
    // Skips carry no provenance; never publish them as System Default usage.
    const stillActive =
      !currentCodexHome.skip &&
      this.isSameCodexTarget(this.codexFetchTarget, target) &&
      this.getCodexProvenance(target, currentCodexHome.homePath) ===
        this.getCodexProvenance(target, codexHomePath)
    if (stillActive) {
      // Redemption is newer than prior reads; invalidate their generations before publishing.
      this.codexFetchGeneration += 1
      this.trackActiveFailureStreak('codex', fresh)
      this.updateState({
        ...this.state,
        codex: this.applyStalePolicy(fresh, this.state.codex)
      })
    }

    // Return the redeemed target even if global selection changed mid-request.
    return { ...stateBeforeReset, codex: scopedCodex, codexTarget: target }
  }

  protected shouldAllowClaudePtyFallback(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined
  ): boolean {
    // Hidden Windows PTYs are less reliable; keep this supplement disabled.
    if (process.platform === 'win32') {
      return false
    }
    // System Default may read OAuth but must not launch Claude auth/browser flows.
    return !isSystemDefaultClaudeAuth(authPreparation)
  }

  protected shouldAllowClaudeUsagePanelSupplement(): boolean {
    return process.platform !== 'win32'
  }

  protected resolveOpenCodeGoConfig(): OpenCodeGoResolvedConfig {
    const config = this.openCodeGoConfigResolver?.() ?? {
      sessionCookie: '',
      workspaceIdOverride: ''
    }
    try {
      return {
        ...config,
        apiKey: this.openCodeGoApiKeyResolver?.() ?? '',
        apiKeyError: null,
        apiKeyReadSkipped: false
      }
    } catch (error) {
      // Transient key-file failure supplies no verdict; skip this cycle without blaming credentials.
      if (error instanceof ApiKeyFileUnreadableError) {
        return { ...config, apiKey: '', apiKeyError: null, apiKeyReadSkipped: true }
      }
      // Cookie/store fallback remains usable when the saved key cannot decrypt.
      return {
        ...config,
        apiKey: '',
        apiKeyError:
          'OpenCode Go API key could not be decrypted. Re-enter or clear the key in Settings.',
        apiKeyReadSkipped: false
      }
    }
  }

  protected resolveMiniMaxConfig(): MiniMaxResolvedConfig {
    try {
      return {
        config: this.miniMaxConfigResolver?.() ?? {
          sessionCookie: '',
          groupId: '',
          models: 'general',
          endpoint: 'overseas',
          apiKey: ''
        },
        error: null
      }
    } catch (error) {
      // Cookie failure affects MiniMax only, not sibling refreshes.
      return {
        config: {
          sessionCookie: '',
          groupId: '',
          models: 'general',
          endpoint: 'overseas',
          apiKey: ''
        },
        error: toErrorMessage(error)
      }
    }
  }

  protected resolveZcodePlanConfig(): ZcodePlanResolvedConfig {
    try {
      return {
        config: this.zcodePlanConfigResolver?.() ?? { site: 'zai', apiKey: '' },
        error: null
      }
    } catch (error) {
      // Key decryption failure affects ZCode only, not sibling refreshes.
      return { config: { site: 'zai', apiKey: '' }, error: toErrorMessage(error) }
    }
  }
}
