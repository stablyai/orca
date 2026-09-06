import { RateLimitServiceResultPolicy } from './service-result-policy'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchKimiRateLimits } from '../kimi-fetcher'
import {
  isSystemDefaultClaudeAuth,
  type ClaudeRuntimeAuthPreparation,
  type CodexAccountSelectionTarget,
  type MiniMaxResolvedConfig,
  type NormalizedCodexAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget,
  type ProviderRateLimits,
  type RateLimitState,
  toErrorMessage
} from './service-types'

export abstract class RateLimitServiceFetchTargets extends RateLimitServiceResultPolicy {
  protected resolveCodexHome(target?: CodexAccountSelectionTarget): {
    skip: boolean
    homePath: string | null
  } {
    const resolution = this.codexHomePathResolver?.(target)
    if (!resolution) {
      return { skip: false, homePath: null }
    }
    return resolution.kind === 'skip'
      ? { skip: true, homePath: null }
      : { skip: false, homePath: resolution.codexHomePath }
  }

  // Why: resolving a WSL home probes wsl.exe, so it must not run before the other
  // providers' fetches are started; chaining keeps the no-resolver path immediate.
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
    stateBeforeReset: RateLimitState
  ): Promise<RateLimitState> {
    const controller = this.beginFetchCycle()
    let fresh: ProviderRateLimits
    try {
      fresh = await fetchCodexRateLimits({
        codexHomePath,
        allowPtyFallback: this.shouldAllowCodexPtyFallback(),
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

    const scopedCodex = this.applyStalePolicy(fresh, stateBeforeReset.codex)
    const currentCodexHome = this.resolveCodexHome(target)
    // Why: a skip has no provenance to compare, so treat it as no longer active
    // rather than publishing this result against the system-default lane.
    const stillActive =
      !currentCodexHome.skip &&
      this.isSameCodexTarget(this.codexFetchTarget, target) &&
      this.getCodexProvenance(target, currentCodexHome.homePath) ===
        this.getCodexProvenance(target, codexHomePath)
    if (stillActive) {
      // Why: this post-redemption read is newer than every Codex fetch that
      // started before it, so invalidate those results before publishing it.
      this.codexFetchGeneration += 1
      this.trackActiveFailureStreak('codex', fresh)
      this.updateState({
        ...this.state,
        codex: this.applyStalePolicy(fresh, this.state.codex)
      })
    }

    // Why: the caller must receive the redeemed target even if the global UI
    // switched targets while the provider mutation was in flight.
    return { ...stateBeforeReset, codex: scopedCodex, codexTarget: target }
  }

  protected shouldAllowCodexPtyFallback(): boolean {
    // Why: hidden PTY fallback can crash inside ConPTY on Windows; prefer RPC-only degradation there for background quota refresh.
    return process.platform !== 'win32'
  }

  protected shouldAllowClaudePtyFallback(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined
  ): boolean {
    // Why: Windows hidden PTY support is less reliable than host/WSL shells.
    if (process.platform === 'win32') {
      return false
    }
    // Why: system-default Claude isn't Orca-managed; refresh may read existing OAuth but must not launch Claude and trigger auth/browser flows.
    return !isSystemDefaultClaudeAuth(authPreparation)
  }

  protected shouldAllowClaudeUsagePanelSupplement(): boolean {
    // Why: keep this supplement off on Windows where hidden PTYs are still less reliable.
    return process.platform !== 'win32'
  }

  protected resolveMiniMaxConfig(): MiniMaxResolvedConfig {
    try {
      return {
        config: this.miniMaxConfigResolver?.() ?? {
          sessionCookie: '',
          groupId: '',
          models: 'general'
        },
        error: null
      }
    } catch (error) {
      // Why: one unreadable cookie must not abort every provider's refresh; surface it as MiniMax-only state instead.
      return {
        config: {
          sessionCookie: '',
          groupId: '',
          models: 'general'
        },
        error: toErrorMessage(error)
      }
    }
  }
}
