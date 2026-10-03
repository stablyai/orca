import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getConfigPath, type ClaudeCompatibleHookSettings } from './hook-settings'

/** The default settings a profile follows; `userHome` comes from the caller so both halves agree on it. */
export function getDefaultSettingsPath(
  settings: ClaudeCompatibleHookSettings,
  userHome?: string
): string {
  return getConfigPath(
    settings,
    userHome === undefined ? undefined : join(userHome, settings.configDirName)
  )
}

function sameFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true
  }
  try {
    // Why: file identity, not spelling, so links and case-only aliases both compare equal.
    const leftStats = statSync(left, { bigint: true })
    const rightStats = statSync(right, { bigint: true })
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino
  } catch (error) {
    // Why: only a definitive absence proves they differ; any other failure refuses.
    return !isDefinitiveAbsence(error)
  }
}

/** A profile destination that is, or links into, the default home would edit System Default's hooks. */
export function profileTargetsDefaultHome(
  settings: ClaudeCompatibleHookSettings,
  configDir: string,
  userHome?: string
): boolean {
  const defaultSettings = getDefaultSettingsPath(settings, userHome)
  return (
    sameFile(configDir, dirname(defaultSettings)) ||
    sameFile(getConfigPath(settings, configDir), defaultSettings)
  )
}
