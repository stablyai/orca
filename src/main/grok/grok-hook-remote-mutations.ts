import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { writeManagedScriptRemote } from '../agent-hooks/installer-utils-remote'
import {
  readHooksJsonRemoteWithRaw,
  removeTextFileRemoteIfUnchanged,
  writeHooksJsonRemoteIfUnchanged
} from '../agent-hooks/remote-hook-config-generation'
import { buildInstalledGrokConfig } from './grok-hook-config'
import { removeManagedGrokHookEntries } from './grok-hook-config-cleanup'
import { GROK_HOME_ENVELOPE_MAX_LENGTH } from './windows-grok-hook-script'

function remoteStatus(configPath: string, detail: string | null = null): AgentHookInstallStatus {
  return {
    agent: 'grok',
    state: detail ? 'error' : 'not_installed',
    configPath,
    managedHooksPresent: false,
    detail
  }
}

function remoteGrokHome(remoteHome: string, candidateHome?: string): string {
  const home = remoteHome.replace(/\/+$/, '') || remoteHome
  const candidate = candidateHome?.trim()
  if (
    candidate &&
    candidate === candidateHome &&
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
    const snapshot = await readHooksJsonRemoteWithRaw(sftp, configPath)
    const config = snapshot.config
    if (!config) {
      return remoteStatus(configPath, 'Could not parse remote Grok hook config')
    }
    if (snapshot.raw !== null && Object.keys(config.hooks ?? {}).length === 0) {
      return remoteStatus(configPath)
    }
    buildInstalledGrokConfig(config, wrapPosixHookCommand(scriptPath), 'grok-hook.sh')
    await writeManagedScriptRemote(sftp, scriptPath, script)
    if (!(await writeHooksJsonRemoteIfUnchanged(sftp, configPath, snapshot.raw, config))) {
      return remoteStatus(configPath, 'Remote Grok hook config changed during installation')
    }
    return {
      agent: 'grok',
      state: 'installed',
      configPath,
      managedHooksPresent: true,
      detail: null
    }
  } catch (error) {
    return remoteStatus(configPath, error instanceof Error ? error.message : String(error))
  }
}

export async function removeRemoteGrokHook(
  sftp: SFTPWrapper,
  remoteHome: string,
  remoteGrokHomeDir?: string
): Promise<AgentHookInstallStatus> {
  const home = remoteHome.replace(/\/$/, '')
  const configPath = `${remoteGrokHome(home, remoteGrokHomeDir)}/hooks/orca-status.json`
  try {
    const snapshot = await readHooksJsonRemoteWithRaw(sftp, configPath)
    if (!snapshot.config) {
      return remoteStatus(configPath, 'Could not parse remote Grok hook config')
    }
    if (snapshot.raw === null) {
      return remoteStatus(configPath)
    }
    const cleanup = removeManagedGrokHookEntries(snapshot.config, 'grok-hook.sh')
    if (!cleanup.removedAny) {
      return remoteStatus(configPath)
    }
    const updated =
      Object.keys(cleanup.config).length === 0
        ? await removeTextFileRemoteIfUnchanged(sftp, configPath, snapshot.raw)
        : await writeHooksJsonRemoteIfUnchanged(sftp, configPath, snapshot.raw, cleanup.config)
    return updated
      ? remoteStatus(configPath)
      : remoteStatus(configPath, 'Remote Grok hook config changed during cleanup')
  } catch (error) {
    return remoteStatus(configPath, error instanceof Error ? error.message : String(error))
  }
}
