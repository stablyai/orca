import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { createEmptyRateLimitState } from '../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { toErrorMessage } from './service-types'
import {
  normalizeCodexAccountSelectionTarget,
  type NormalizedCodexAccountSelectionTarget
} from '../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  normalizeClaudeAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget
} from '../../claude-accounts/selection/runtime-selection'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { RateLimitServiceAccountRefresh } from './service-account-refresh'

// Why: a hung WSL probe must not pin the renderer's owner usage read forever.
const TARGET_USAGE_READ_TIMEOUT_MS = 30_000

export abstract class RateLimitServiceTargetUsageRead extends RateLimitServiceAccountRefresh {
  /** One runtime target's selected Claude and Codex readings, for a focused WSL host's distro.
   *  The read never switches this desktop's own fetch target or publishes state, so the host
   *  runtime's numbers stay untouched (#42644 follow-up). */
  async readUsageForRuntimeTarget(target: RateLimitRuntimeTarget): Promise<RateLimitState> {
    const claudeTarget = normalizeClaudeAccountSelectionTarget(target)
    const codexTarget = normalizeCodexAccountSelectionTarget(target)
    const signal = AbortSignal.timeout(TARGET_USAGE_READ_TIMEOUT_MS)
    // Each provider fails alone: one resolver's rejection must not discard the other's reading.
    const [claude, codex] = await Promise.all([
      this.readClaudeUsageForTarget(claudeTarget, signal).catch((error): ProviderRateLimits =>
        usageReadError('claude', error)
      ),
      this.readCodexUsageForTarget(codexTarget, signal).catch((error): ProviderRateLimits =>
        usageReadError('codex', error)
      )
    ])
    return createEmptyRateLimitState({ claude, codex, claudeTarget, codexTarget })
  }

  private async readClaudeUsageForTarget(
    target: NormalizedClaudeAccountSelectionTarget,
    signal: AbortSignal
  ): Promise<ProviderRateLimits | null> {
    // Why null: live statusline data belongs to the desktop's own fetch target, not this read's.
    if (!this.isClaudeOAuthUsageEnabled()) {
      return null
    }
    const preparation = await raceDeadline(this.claudeAuthPreparationResolver?.(target), signal)
    return fetchActiveClaudeRateLimits({
      authPreparation: preparation,
      allowPtyFallback: this.shouldAllowClaudePtyFallback(preparation),
      allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    })
  }

  private async readCodexUsageForTarget(
    target: NormalizedCodexAccountSelectionTarget,
    signal: AbortSignal
  ): Promise<ProviderRateLimits | null> {
    // The deadline must cover the WSL probes, not just the fetch: raceDeadline rejects a hung one.
    const home = await raceDeadline(this.resolveCodexHome(target), signal)
    if (!home) {
      throw new Error('Codex home probe timed out')
    }
    // Why null: a stopped distro must not be booted by an owner usage read.
    if (home.skip) {
      return null
    }
    const missingWslHome = home.homePath ? null : this.getMissingWslCodexHomeResult(target)
    if (missingWslHome) {
      return missingWslHome
    }
    return fetchCodexRateLimits({
      codexHomePath: home.homePath,
      readingAccount: home.readingAccount,
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    })
  }
}

/** Rejects at the signal's deadline; the abandoned probe cannot be cancelled, only ignored. */
function raceDeadline<T>(
  promise: Promise<T> | undefined,
  signal: AbortSignal
): Promise<T | undefined> {
  signal.throwIfAborted()
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  return Promise.race([promise ?? Promise.resolve(undefined), deadline])
}

function usageReadError(provider: 'claude' | 'codex', error: unknown): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: toErrorMessage(error),
    status: 'error'
  }
}
