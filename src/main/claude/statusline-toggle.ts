import { existsSync, writeFileSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import { readHooksJson, writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  applyManagedStatusLine,
  getConfigPath,
  getManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  getRemoteManagedCommand,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { getManagedStatusLineScript } from './statusline-script'

// Why: the statusline feed is opportunistic (usage display, not agent status); a user who deleted the
// managed entry has opted out, and the marker distinguishes that deletion from a first install.
export function installManagedClaudeStatusLine(
  settings: ClaudeCompatibleHookSettings,
  config: HooksConfig,
  contextPressureEnabled: boolean
): HooksConfig {
  const scriptFileName = getStatusLineScriptFileName(settings)
  const markerPath = getStatusLineInstallMarkerPath(settings)
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
    return config
  }
  const statusLineScriptPath = getStatusLineScriptPath(settings)
  writeManagedScript(
    statusLineScriptPath,
    getManagedStatusLineScript('local', contextPressureEnabled)
  )
  const next = applyManagedStatusLine(
    config,
    getManagedCommand(statusLineScriptPath),
    scriptFileName
  )
  try {
    writeFileSync(markerPath, '')
  } catch {
    // Best-effort: a missing marker only means one future user deletion gets re-installed once.
  }
  return next
}

export function rewriteManagedClaudeStatusLine(
  settings: ClaudeCompatibleHookSettings,
  enabled: boolean
): void {
  const config = readHooksJson(getConfigPath(settings))
  if (
    config &&
    getStatusLineSlotState(config, getStatusLineScriptFileName(settings)) === 'managed'
  ) {
    writeManagedScript(
      getStatusLineScriptPath(settings),
      getManagedStatusLineScript('local', enabled)
    )
  }
}

/** Remote statusline install for the SSH/WSL hook path. Owns the remote
 *  script path derivation (POSIX `.sh`, under the discovered remote home). */
export async function installRemoteClaudeStatusLineForHome(
  sftp: SFTPWrapper,
  config: HooksConfig,
  remoteHome: string,
  settings: ClaudeCompatibleHookSettings,
  contextPressureEnabled: boolean
): Promise<HooksConfig> {
  const scriptFileName = getStatusLineScriptFileName(settings)
  const scriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${scriptFileName}`
  return installRemoteClaudeStatusLine(
    sftp,
    config,
    scriptPath,
    scriptFileName,
    contextPressureEnabled
  )
}

export async function installRemoteClaudeStatusLine(
  sftp: SFTPWrapper,
  config: HooksConfig,
  scriptPath: string,
  scriptFileName: string,
  enabled: boolean
): Promise<HooksConfig> {
  // Why: mirror the local install policy — a user-owned slot, or an empty slot after a prior
  // install (marker on the remote box), is a user opt-out; never re-claim it on reconnect.
  const markerPath = `${scriptPath}.installed`
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (
    slot === 'user' ||
    (slot === 'empty' && (await readTextFileRemote(sftp, markerPath)) !== null)
  ) {
    return config
  }
  await writeManagedScriptRemote(sftp, scriptPath, getManagedStatusLineScript('posix', enabled))
  const next = applyManagedStatusLine(config, getRemoteManagedCommand(scriptPath), scriptFileName)
  try {
    await writeTextFileRemoteAtomic(sftp, markerPath, '')
  } catch {
    // Best-effort: a missing marker only means one future user deletion gets re-installed once.
  }
  return next
}
