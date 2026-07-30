import type { GlobalSettings } from '../../shared/types'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
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
    if (platform !== 'win32') {
      return { runtime: 'host' }
    }
    return {
      runtime: 'wsl',
      wslDistro:
        normalizeOptionalDistro(settings.localAccountWslDistro) ??
        getSingleSelectedWslDistro(settings)
    }
  }
  if (settings.localAccountRuntime === 'auto') {
    const target = resolveLocalAccountRuntimeTarget(settings, platform)
    return target.runtime === 'wsl'
      ? { runtime: 'wsl', wslDistro: target.wslDistro }
      : { runtime: 'host' }
  }

  // Why: pre-setting profiles used account selection as their startup fallback.
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
