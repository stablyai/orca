import type { GlobalSettings } from '../../shared/types'
import {
  getClaudeWslSelectionKey,
  normalizeClaudeRuntimeSelection,
  type ClaudeAccountSelectionTarget
} from '../claude-accounts/runtime-selection'
import {
  getProjectRuntimeRateLimitTarget,
  normalizeOptionalDistro
} from './project-runtime-rate-limit-target'

function getSingleSelectedWslDistro(settings: GlobalSettings): string | null {
  const selection = normalizeClaudeRuntimeSelection(settings)
  const selectedWslEntries = Object.entries(selection.wsl).filter(([, accountId]) =>
    Boolean(accountId)
  )
  if (selectedWslEntries.length !== 1) {
    return null
  }
  const [distroKey] = selectedWslEntries[0]
  return distroKey === getClaudeWslSelectionKey(null) ? null : distroKey
}

export function getInitialClaudeRateLimitTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): ClaudeAccountSelectionTarget {
  if (settings.localAccountRuntime === 'host') {
    return { runtime: 'host' }
  }
  if (settings.localAccountRuntime === 'wsl') {
    return {
      runtime: 'wsl',
      wslDistro:
        normalizeOptionalDistro(settings.localAccountWslDistro) ??
        getSingleSelectedWslDistro(settings)
    }
  }

  const projectRuntimeTarget = getProjectRuntimeRateLimitTarget(settings, platform)
  if (projectRuntimeTarget) {
    return projectRuntimeTarget
  }

  const selection = normalizeClaudeRuntimeSelection(settings)
  if (!selection.host) {
    const selectedWslEntries = Object.entries(selection.wsl).filter(([, accountId]) =>
      Boolean(accountId)
    )
    if (selectedWslEntries.length === 1) {
      const [distroKey] = selectedWslEntries[0]
      return {
        runtime: 'wsl',
        wslDistro: distroKey === getClaudeWslSelectionKey(null) ? null : distroKey
      }
    }
  }

  return { runtime: 'host' }
}
