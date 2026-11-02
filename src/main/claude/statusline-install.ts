import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import { getManagedStatusLineCommand, getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedStatusLine,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

// The marker distinguishes a user-deleted statusline from a first install.
export function installClaudeManagedStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): HooksConfig {
  const scriptFileName = getStatusLineScriptFileName(settings)
  const markerPath = getStatusLineInstallMarkerPath(settings)
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
    return config
  }
  const scriptPath = getStatusLineScriptPath(settings)
  writeManagedScript(scriptPath, getManagedStatusLineScript('local'))
  const next = applyManagedStatusLine(
    config,
    getManagedStatusLineCommand(scriptPath),
    scriptFileName
  )
  try {
    writeFileSync(markerPath, '')
  } catch {
    // Marker failure may cause a later user deletion to be reinstalled.
  }
  return next
}

// Older CLIs reject statusLine; clear the marker so an upgrade can reinstall it.
export function retireClaudeManagedStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): HooksConfig {
  const { config: next, changed } = removeManagedStatusLine(
    config,
    getStatusLineScriptFileName(settings)
  )
  if (changed) {
    try {
      rmSync(getStatusLineInstallMarkerPath(settings), { force: true })
    } catch {
      // A stale marker can suppress reinstall after an upgrade.
    }
  }
  return next
}
