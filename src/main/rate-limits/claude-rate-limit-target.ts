import type { GlobalSettings } from '../../shared/types'
import {
  getClaudeWslSelectionKey,
  normalizeClaudeRuntimeSelection,
  type ClaudeAccountSelectionTarget
} from '../claude-accounts/runtime-selection'

function normalizeOptionalDistro(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

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
        normalizeOptionalDistro(settings.terminalWindowsWslDistro) ??
        getSingleSelectedWslDistro(settings)
    }
  }

  if (
    settings.localAgentRuntime === 'wsl' ||
    (settings.localAgentRuntime == null &&
      platform === 'win32' &&
      settings.terminalWindowsShell === 'wsl.exe')
  ) {
    return {
      runtime: 'wsl',
      wslDistro:
        normalizeOptionalDistro(settings.localAgentWslDistro) ??
        normalizeOptionalDistro(settings.terminalWindowsWslDistro)
    }
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
