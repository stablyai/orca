import type { GlobalSettings } from '../../shared/types'
import { normalizeGlobalWindowsRuntimeDefault } from '../../shared/project-execution-runtime'

export type AccountRateLimitRuntimeTarget =
  | { runtime: 'host' }
  | { runtime: 'wsl'; wslDistro: string | null }

export function getProjectRuntimeRateLimitTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform
): AccountRateLimitRuntimeTarget | null {
  if (platform !== 'win32') {
    return null
  }

  const runtimeDefault = normalizeGlobalWindowsRuntimeDefault(settings.localWindowsRuntimeDefault)
  if (runtimeDefault.kind !== 'wsl') {
    return null
  }

  // Why: account quota polling has no project id, so its best default is the
  // global project runtime instead of stale terminal/agent WSL settings.
  return { runtime: 'wsl', wslDistro: runtimeDefault.distro }
}

export function normalizeOptionalDistro(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
