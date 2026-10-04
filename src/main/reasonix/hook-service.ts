import { readFileSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeHooksJson, writeManagedScript } from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeHooksJsonRemote
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  getReasonixConfigPath,
  getReasonixManagedCommand,
  getReasonixScriptPath,
  parseReasonixHookSettings,
  reasonixManagedHookEvents,
  REASONIX_HOOK_EVENTS,
  updateReasonixManagedHooks
} from './hook-settings'
import { isReasonixRemoteConfigHome } from '../../shared/reasonix-config-roots'
import { resolveReasonixExecutionHostConfig } from './execution-host-config'
import { reasonixHookScript } from './hook-script'

function readConfig(path: string): Record<string, unknown> {
  try {
    return parseReasonixHookSettings(readFileSync(path, 'utf8'))
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return {}
    }
    throw error
  }
}

function status(path: string, config: Record<string, unknown>): AgentHookInstallStatus {
  const present = reasonixManagedHookEvents(config)
  const missing = REASONIX_HOOK_EVENTS.filter((event) => !present.has(event))
  return {
    agent: 'reasonix',
    configPath: path,
    managedHooksPresent: present.size > 0,
    state: missing.length === 0 ? 'installed' : present.size ? 'partial' : 'not_installed',
    detail: present.size && missing.length ? `Missing events: ${missing.join(', ')}` : null
  }
}

function failure(path: string, error: unknown): AgentHookInstallStatus {
  return {
    agent: 'reasonix',
    configPath: path,
    state: 'error',
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

export class ReasonixHookService {
  private executionHostConfigHome?: string

  async installForExecutionHost(): Promise<AgentHookInstallStatus> {
    try {
      this.executionHostConfigHome = await resolveReasonixExecutionHostConfig()
      return this.install()
    } catch (error) {
      return failure(getReasonixConfigPath(this.executionHostConfigHome), error)
    }
  }

  async removeForExecutionHost(): Promise<AgentHookInstallStatus> {
    try {
      this.executionHostConfigHome = await resolveReasonixExecutionHostConfig()
      return this.remove()
    } catch (error) {
      return failure(getReasonixConfigPath(this.executionHostConfigHome), error)
    }
  }
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(
      getReasonixScriptPath(),
      reasonixHookScript(process.platform)
    )
  }

  getStatus(): AgentHookInstallStatus {
    const path = getReasonixConfigPath(this.executionHostConfigHome)
    try {
      return status(path, readConfig(path))
    } catch (error) {
      return failure(path, error)
    }
  }

  install(): AgentHookInstallStatus {
    const path = getReasonixConfigPath(this.executionHostConfigHome)
    try {
      const config = updateReasonixManagedHooks(
        readConfig(path),
        getReasonixManagedCommand(getReasonixScriptPath())
      )
      writeManagedScript(getReasonixScriptPath(), reasonixHookScript(process.platform))
      writeHooksJson(path, config)
      return status(path, config)
    } catch (error) {
      return failure(path, error)
    }
  }

  remove(): AgentHookInstallStatus {
    const path = getReasonixConfigPath(this.executionHostConfigHome)
    try {
      const config = updateReasonixManagedHooks(readConfig(path))
      writeHooksJson(path, config)
      return status(path, config)
    } catch (error) {
      return failure(path, error)
    }
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    configHomeDir?: string
  ): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const configHome = configHomeDir ?? `${home}/.reasonix`
    const path = `${configHome.replace(/\/$/, '')}/settings.json`
    try {
      if (!isReasonixRemoteConfigHome(configHome)) {
        throw new Error('Invalid Reasonix remote configuration root')
      }
      const script = `${home}/.orca/agent-hooks/reasonix-hook.sh`
      const config = updateReasonixManagedHooks(
        parseReasonixHookSettings(await readTextFileRemote(sftp, path)),
        getReasonixManagedCommand(script, 'linux')
      )
      await writeManagedScriptRemote(sftp, script, reasonixHookScript('linux'))
      await writeHooksJsonRemote(sftp, path, config)
      return status(path, config)
    } catch (error) {
      return failure(path, error)
    }
  }
}

export const reasonixHookService = new ReasonixHookService()
