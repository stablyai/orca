import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitState } from '../../shared/rate-limit-types'
import type { RateLimitService } from './service'
import { getInitialClaudeRateLimitTarget } from './claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'
import { getGrokRuntimeTarget } from '../grok/grok-runtime-home'

type AccountRuntimeRateLimitService = Pick<
  RateLimitService,
  'getState' | 'refreshClaudeForTarget' | 'refreshCodexForTarget' | 'refreshGrokForTarget'
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
    const grokPolicyChanged = !isSameTarget(settingsTargets.grok, nextSettingsTargets.grok)
    settingsTargets = nextSettingsTargets
    if (!claudePolicyChanged && !codexPolicyChanged && !grokPolicyChanged) {
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
    if (grokPolicyChanged) {
      refreshes.push(rateLimits.refreshGrokForTarget(nextSettingsTargets.grok))
    }

    await Promise.all(refreshes)
  }
}

function getSettingsTargets(settings: GlobalSettings, platform: NodeJS.Platform) {
  return {
    claude: getInitialClaudeRateLimitTarget(settings, platform),
    codex: getInitialCodexRateLimitTarget(settings, platform),
    grok: getGrokRuntimeTarget(settings, platform)
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
