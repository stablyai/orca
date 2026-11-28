import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
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
  RuntimeTargetUsageProvider,
  RuntimeTargetUsageRead
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { RateLimitServiceAccountRefresh } from './service-account-refresh'

// Why: a hung WSL probe must not pin the renderer's owner usage read forever.
const TARGET_USAGE_READ_TIMEOUT_MS = 30_000

const PROVIDERS: readonly RuntimeTargetUsageProvider[] = ['claude', 'codex']

type ProviderRead = { reading: ProviderRateLimits | null; readingAccountId?: string }

export abstract class RateLimitServiceTargetUsageRead extends RateLimitServiceAccountRefresh {
  /** A WSL distro's selected-account readings; never switches this desktop's fetch target or publishes state (#42644). */
  async readUsageForRuntimeTarget(
    target: RateLimitRuntimeTarget,
    providers: readonly RuntimeTargetUsageProvider[],
    readSelection: () => Record<RuntimeTargetUsageProvider, string | null>
  ): Promise<RuntimeTargetUsageRead> {
    // Why: the list arrives over IPC, so only known providers are read.
    const wanted = PROVIDERS.filter((p) => Array.isArray(providers) && providers.includes(p))
    const before = readSelection()
    const signal = AbortSignal.timeout(TARGET_USAGE_READ_TIMEOUT_MS)
    const readOne = (provider: RuntimeTargetUsageProvider): Promise<ProviderRead> =>
      this.readProviderForTarget(provider, target, signal).catch((error): ProviderRead => ({
        reading: usageReadError(provider, error)
      }))
    // Each provider fails alone: one resolver's rejection must not discard the other's reading.
    const reads = await Promise.all(wanted.map(readOne))
    const after = readSelection()
    const result: RuntimeTargetUsageRead = {}
    wanted.forEach((provider, index) => {
      const { reading, readingAccountId } = reads[index]
      // Why: the resolver's own account wins; otherwise only an unchanged selection proves whose reading it is.
      const accountId =
        readingAccountId ?? (before[provider] === after[provider] ? after[provider] : undefined)
      if (accountId !== undefined) {
        result[provider] = { accountId, reading }
      }
    })
    return result
  }

  private async readProviderForTarget(
    provider: RuntimeTargetUsageProvider,
    target: RateLimitRuntimeTarget,
    signal: AbortSignal
  ): Promise<ProviderRead> {
    // Why: off Windows there is no WSL route, and the resolvers would fall back to the host's account.
    if (target.runtime === 'wsl' && process.platform !== 'win32') {
      throw new Error('WSL is not available on this device.')
    }
    return provider === 'claude'
      ? this.readClaudeUsageForTarget(normalizeClaudeAccountSelectionTarget(target), signal)
      : this.readCodexUsageForTarget(normalizeCodexAccountSelectionTarget(target), signal)
  }

  private async readClaudeUsageForTarget(
    target: NormalizedClaudeAccountSelectionTarget,
    signal: AbortSignal
  ): Promise<ProviderRead> {
    // Why null: live statusline data belongs to the desktop's own fetch target, not this read's.
    if (!this.isClaudeOAuthUsageEnabled()) {
      return { reading: null }
    }
    const preparation = await raceDeadline(this.claudeAuthPreparationResolver?.(target), signal)
    const reading = await fetchActiveClaudeRateLimits({
      authPreparation: preparation,
      allowPtyFallback: this.shouldAllowClaudePtyFallback(preparation),
      allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    })
    return { reading, readingAccountId: preparation?.readingAccount?.accountId }
  }

  private async readCodexUsageForTarget(
    target: NormalizedCodexAccountSelectionTarget,
    signal: AbortSignal
  ): Promise<ProviderRead> {
    // The deadline must cover the WSL probes, not just the fetch: raceDeadline rejects a hung one.
    const home = await raceDeadline(this.resolveCodexHome(target), signal)
    if (!home) {
      throw new Error('Codex home probe timed out')
    }
    // Why null: a stopped distro must not be booted by an owner usage read.
    if (home.skip) {
      return { reading: null }
    }
    const readingAccountId = home.readingAccount?.accountId
    const missingWslHome = home.homePath ? null : this.getMissingWslCodexHomeResult(target)
    if (missingWslHome) {
      return { reading: missingWslHome, readingAccountId }
    }
    const reading = await fetchCodexRateLimits({
      codexHomePath: home.homePath,
      readingAccount: home.readingAccount,
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    })
    return { reading, readingAccountId }
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
