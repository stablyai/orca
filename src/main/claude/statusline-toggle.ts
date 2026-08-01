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
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  getRemoteManagedCommand,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { getManagedStatusLineScript } from './statusline-script'

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
