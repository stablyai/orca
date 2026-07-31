import { existsSync, writeFileSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  applyManagedStatusLine,
  CLAUDE_HOOK_SETTINGS,
  getManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { getManagedStatusLineScript } from './statusline-script'

export function managesClaudeStatusLine(
  agent: AgentHookInstallStatus['agent'],
  settings: ClaudeCompatibleHookSettings
): boolean {
  return agent === 'claude' && settings.configDirName === CLAUDE_HOOK_SETTINGS.configDirName
}

export function installManagedStatusLine(
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
  return applyManagedStatusLine(config, getManagedCommand(scriptPath), scriptFileName)
}

export function recordManagedStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): void {
  if (getStatusLineSlotState(config, getStatusLineScriptFileName(settings)) !== 'managed') {
    return
  }
  try {
    writeFileSync(getStatusLineInstallMarkerPath(settings), '')
  } catch {
    // Best-effort: a missing marker only means one future user deletion gets re-installed once.
  }
}
