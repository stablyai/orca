import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitState } from '../../shared/rate-limit-types'
import type { RateLimitService } from './service'
import { getInitialClaudeRateLimitTarget } from './claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'
import { resolveLocalAccountUsageTarget } from '../../shared/local-account-runtime'

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
    const usageTargetChanged = !isSameTarget(settingsTargets.usage, nextSettingsTargets.usage)
    settingsTargets = nextSettingsTargets
    if (!claudePolicyChanged && !codexPolicyChanged && !usageTargetChanged) {
      return
    }

    const current = rateLimits.getState()
    const refreshes: Promise<RateLimitState>[] = []
    if (claudePolicyChanged && !isSameTarget(current.claudeTarget, nextSettingsTargets.claude)) {
      refreshes.push(rateLimits.refreshClaudeForTarget(nextSettingsTargets.claude))
    }
    if (codexPolicyChanged && !isSameTarget(current.codexTarget, nextSettingsTargets.codex)) {
      refreshes.push(rateLimits.refreshCodexForTarget(nextSettingsTargets.codex))
    }

    await Promise.all(refreshes)
    // Antigravity has no targeted refresh; queueing a full one beside targeted ones can drop their reruns.
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
