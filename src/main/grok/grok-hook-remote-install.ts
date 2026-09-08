import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { buildInstalledGrokConfig } from './grok-hook-config'
import { GROK_HOME_ENVELOPE_MAX_LENGTH } from './windows-grok-hook-script'

function status(configPath: string, detail: string | null = null): AgentHookInstallStatus {
  return {
    agent: 'grok',
    state: detail ? 'error' : 'not_installed',
    configPath,
    managedHooksPresent: false,
    detail
  }
}

function remoteGrokHome(remoteHome: string, remoteGrokHome?: string): string {
  const home = remoteHome.replace(/\/+$/, '') || remoteHome
  const candidate = remoteGrokHome?.trim()
  if (
    candidate &&
    candidate === remoteGrokHome &&
    candidate.startsWith('/') &&
    !candidate.includes('\\') &&
    candidate.length <= GROK_HOME_ENVELOPE_MAX_LENGTH &&
    !Array.from(candidate).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return candidate.replace(/\/+$/, '') || '/'
  }
  return `${home}/.grok`
}

export async function installRemoteGrokHook(
  sftp: SFTPWrapper,
  remoteHome: string,
  remoteGrokHomeDir: string | undefined,
  script: string
): Promise<AgentHookInstallStatus> {
  const home = remoteHome.replace(/\/$/, '')
  const configPath = `${remoteGrokHome(home, remoteGrokHomeDir)}/hooks/orca-status.json`
  const scriptPath = `${home}/.orca/agent-hooks/grok-hook.sh`
  try {
    const config = await readHooksJsonRemote(sftp, configPath)
    if (!config) {
      return status(configPath, 'Could not parse remote Grok hook config')
    }
    buildInstalledGrokConfig(
      config,
      wrapPosixHookCommand(scriptPath, {}, { requiredEnvVar: 'ORCA_PANE_KEY' }),
      'grok-hook.sh'
    )
    await writeManagedScriptRemote(sftp, scriptPath, script)
    await writeHooksJsonRemote(sftp, configPath, config)
    return {
      agent: 'grok',
      state: 'installed',
      configPath,
      managedHooksPresent: true,
      detail: null
    }
  } catch (error) {
    return status(configPath, error instanceof Error ? error.message : String(error))
  }
}
