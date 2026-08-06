import type { GlobalSettings } from '../../shared/types'
import type { RateLimitState } from '../../shared/rate-limit-types'
import type { RateLimitService } from './service'
import { getInitialClaudeRateLimitTarget } from './claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'

type AccountRuntimeRateLimitService = Pick<
  RateLimitService,
  'getState' | 'refreshClaudeForTarget' | 'refreshCodexForTarget'
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
    settingsTargets = nextSettingsTargets
    if (!claudePolicyChanged && !codexPolicyChanged) {
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
  }
}

function getSettingsTargets(settings: GlobalSettings, platform: NodeJS.Platform) {
  return {
    claude: getInitialClaudeRateLimitTarget(settings, platform),
    codex: getInitialCodexRateLimitTarget(settings, platform)
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
