import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { RateLimitState } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RateLimitService } from './rate-limit-service'
import { getInitialClaudeRateLimitTarget } from '../providers/claude/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from '../providers/codex/codex-rate-limit-target'
import {
  localAccountRuntimeTargetKey,
  resolveLocalAccountUsageTarget
} from '../../../shared/agent-accounts/local-account-runtime'

type AccountRuntimeRateLimitService = Pick<
  RateLimitService,
  'getState' | 'refreshClaudeForTarget' | 'refreshCodexForTarget' | 'refresh'
>

type RuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export function createAccountRuntimeTargetSettingsSync(
  rateLimits: AccountRuntimeRateLimitService,
  initialSettings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): (updates: Partial<GlobalSettings>, settings: GlobalSettings) => Promise<void> {
  let settingsTargets = getSettingsTargets(initialSettings, platform)

  return async (updates, settings): Promise<void> => {
    if (!containsAccountRuntimeTargetUpdate(updates)) {
      return
    }

    const nextSettingsTargets = getSettingsTargets(settings, platform)
    const claudePolicyChanged = !isSameTarget(settingsTargets.claude, nextSettingsTargets.claude)
    const codexPolicyChanged = !isSameTarget(settingsTargets.codex, nextSettingsTargets.codex)
    const usageTargetChanged =
      localAccountRuntimeTargetKey(settingsTargets.usage) !==
      localAccountRuntimeTargetKey(nextSettingsTargets.usage)
    settingsTargets = nextSettingsTargets
    if (!claudePolicyChanged && !codexPolicyChanged && !usageTargetChanged) {
      return
    }

    const current = await rateLimits.getState()
    const refreshes: Promise<RateLimitState>[] = []
    if (claudePolicyChanged && !isSameTarget(current.claudeTarget, nextSettingsTargets.claude)) {
      refreshes.push(rateLimits.refreshClaudeForTarget(nextSettingsTargets.claude))
    }
    if (codexPolicyChanged && !isSameTarget(current.codexTarget, nextSettingsTargets.codex)) {
      refreshes.push(rateLimits.refreshCodexForTarget(nextSettingsTargets.codex))
    }

    await Promise.all(refreshes)
    // Kimi reads the usage target at fetch time and has no targeted refresh.
    if (usageTargetChanged) {
      await rateLimits.refresh()
    }
  }
}

function getSettingsTargets(settings: GlobalSettings, platform: NodeJS.Platform) {
  return {
    claude: getInitialClaudeRateLimitTarget(settings, platform),
    codex: getInitialCodexRateLimitTarget(settings, platform),
    usage: resolveLocalAccountUsageTarget(settings, platform)
  }
}

function containsAccountRuntimeTargetUpdate(updates: Partial<GlobalSettings>): boolean {
  return (
    'localAccountRuntime' in updates ||
    'localAccountWslDistro' in updates ||
    'localWindowsRuntimeDefault' in updates
  )
}

function isSameTarget(current: RuntimeTarget, next: RuntimeTarget): boolean {
  return (
    (current.runtime ?? 'host') === (next.runtime ?? 'host') &&
    (current.wslDistro ?? null) === (next.wslDistro ?? null)
  )
}
