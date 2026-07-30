import type { SFTPWrapper } from 'ssh2'
import { readHooksJson, writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import { writeManagedScriptRemote } from '../agent-hooks/installer-utils-remote'
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
  await writeManagedScriptRemote(sftp, scriptPath, getManagedStatusLineScript('posix', enabled))
  return applyManagedStatusLine(config, getRemoteManagedCommand(scriptPath), scriptFileName)
}
