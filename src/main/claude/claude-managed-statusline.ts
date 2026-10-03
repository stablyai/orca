import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readHooksJson, writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import { getManagedStatusLineScript } from './statusline-script'
import { getDefaultSettingsPath } from './claude-profile-hook-target'
import {
  applyManagedStatusLine,
  getManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

// Why: the statusline feed is opportunistic (usage display, not agent status); a user who deleted the
// managed entry has opted out, and the marker distinguishes that deletion from a first install.
export function installManagedStatusLine(
  settings: ClaudeCompatibleHookSettings,
  config: HooksConfig,
  configDir?: string,
  userHome?: string
): HooksConfig {
  const scriptFileName = getStatusLineScriptFileName(settings)
  if (configDir !== undefined) {
    // Why: a profile follows the default home's slot, so a default opt-out or custom line reaches every profile.
    const defaults = readHooksJson(getDefaultSettingsPath(settings, userHome))
    if (!defaults) {
      return config
    }
    if (getStatusLineSlotState(defaults, scriptFileName) !== 'managed') {
      return retireManagedStatusLine(settings, config, configDir)
    }
  }
  const markerPath = getStatusLineInstallMarkerPath(settings, configDir)
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
    return config
  }
  const statusLineScriptPath = getStatusLineScriptPath(settings)
  writeManagedScript(statusLineScriptPath, getManagedStatusLineScript('local'))
  const next = applyManagedStatusLine(
    config,
    getManagedCommand(statusLineScriptPath),
    scriptFileName
  )
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, '')
  } catch {
    // Best-effort: a missing marker only means one future user deletion gets re-installed once.
  }
  return next
}

// Why: a Claude that predates statusLine discards the whole settings file over Orca's; dropping the
// marker with it keeps an upgrade from reading the removal as the user's opt-out.
export function retireManagedStatusLine(
  settings: ClaudeCompatibleHookSettings,
  config: HooksConfig,
  configDir?: string
): HooksConfig {
  const { config: next, changed } = removeManagedStatusLine(
    config,
    getStatusLineScriptFileName(settings)
  )
  if (changed) {
    try {
      rmSync(getStatusLineInstallMarkerPath(settings, configDir), { force: true })
    } catch {
      // Best-effort: a stale marker only means one upgrade skips re-adding the statusline.
    }
  }
  return next
}
