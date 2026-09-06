import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isPlainObject, writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  applyManagedStatusLine,
  getManagedCommand,
  getStatusLineBackupPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { getManagedStatusLineScript } from './statusline-script'

export function installManagedClaudeStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings,
  agent: 'claude' | 'openclaude'
): HooksConfig {
  const scriptFileName = getStatusLineScriptFileName(settings)
  const markerPath = getStatusLineInstallMarkerPath(settings)
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (
    (slot === 'user' && process.platform === 'win32') ||
    (slot === 'empty' && existsSync(markerPath))
  ) {
    return config
  }
  const backupPath = getStatusLineBackupPath(settings)
  const current = isPlainObject(config.statusLine) ? config.statusLine : null
  const backup = readStatusLineBackup(backupPath)
  const userStatusLine = slot === 'user' ? current : slot === 'managed' ? backup : null
  const userCommand =
    userStatusLine && typeof userStatusLine.command === 'string'
      ? userStatusLine.command
      : undefined
  if (slot === 'user' && userCommand) {
    writeFileSync(backupPath, JSON.stringify(userStatusLine), { mode: 0o600 })
  }
  const scriptPath = getStatusLineScriptPath(settings)
  writeManagedScript(scriptPath, getManagedStatusLineScript('local', agent, userCommand))
  const next = applyManagedStatusLine(
    config,
    getManagedCommand(scriptPath),
    scriptFileName,
    Boolean(userCommand)
  )
  try {
    writeFileSync(markerPath, '')
  } catch {
    // Best-effort: a missing marker only means one future user deletion gets re-installed once.
  }
  return next
}

export async function getManagedClaudeStatusLineScript(
  settings: ClaudeCompatibleHookSettings,
  agent: 'claude' | 'openclaude'
): Promise<string> {
  const backup = await readStatusLineBackupAsync(getStatusLineBackupPath(settings))
  const userCommand = backup && typeof backup.command === 'string' ? backup.command : undefined
  return getManagedStatusLineScript('local', agent, userCommand)
}

async function readStatusLineBackupAsync(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isPlainObject(value) && typeof value.command === 'string' ? value : null
  } catch {
    return null
  }
}

export function removeManagedClaudeStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): { config: HooksConfig; changed: boolean } {
  const removed = removeManagedStatusLine(config, getStatusLineScriptFileName(settings))
  const backupPath = getStatusLineBackupPath(settings)
  const backup = readStatusLineBackup(backupPath)
  rmSync(backupPath, { force: true })
  return {
    changed: removed.changed,
    config: removed.changed && backup ? { ...removed.config, statusLine: backup } : removed.config
  }
}

function readStatusLineBackup(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isPlainObject(value) && typeof value.command === 'string' ? value : null
  } catch {
    return null
  }
}
