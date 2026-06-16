import type { GlobalSettings } from '../../shared/types'
import {
  getWslSelectionKey,
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from '../codex-accounts/runtime-selection'
import {
  getProjectRuntimeRateLimitTarget,
  normalizeOptionalDistro
} from './project-runtime-rate-limit-target'

function getSingleSelectedWslDistro(settings: GlobalSettings): string | null {
  const selection = normalizeCodexRuntimeSelection(settings)
  const selectedWslEntries = Object.entries(selection.wsl).filter(([, accountId]) =>
    Boolean(accountId)
  )
  if (selectedWslEntries.length !== 1) {
    return null
  }
  const [distroKey] = selectedWslEntries[0]
  return distroKey === getWslSelectionKey(null) ? null : distroKey
}

export function getInitialCodexRateLimitTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): CodexAccountSelectionTarget {
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

  const selection = normalizeCodexRuntimeSelection(settings)
  if (!selection.host) {
    const selectedWslEntries = Object.entries(selection.wsl).filter(([, accountId]) =>
      Boolean(accountId)
    )
    if (selectedWslEntries.length === 1) {
      const [distroKey] = selectedWslEntries[0]
      // Why: after restart there is no last-clicked switcher target, but a
      // single WSL-only active account is the least surprising quota context.
      return {
        runtime: 'wsl',
        wslDistro: distroKey === getWslSelectionKey(null) ? null : distroKey
      }
    }
  }

  return { runtime: 'host' }
}
