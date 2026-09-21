import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  COPILOT_EVENTS,
  definitionHasCurrentCommand,
  definitionHasStaleManagedCommand,
  definitionsChanged,
  getManagedCommand,
  getManagedHookDefinition
} from './copilot-managed-hook-definitions'
import {
  getManagedScript,
  getManagedScriptFileName,
  getManagedScriptPath
} from './copilot-managed-script'
import { installCopilotHooksRemote } from './copilot-remote-hook-install'

function getCopilotHome(): string {
  const fromEnv = process.env.COPILOT_HOME?.trim()
  return fromEnv ? fromEnv : join(homedir(), '.copilot')
}

function getConfigPath(): string {
  return join(getCopilotHome(), 'hooks', 'orca.json')
}

export class CopilotHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Copilot hooks/orca.json'
      }
    }

    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    const missing: string[] = []
    let presentCount = 0
    let staleManagedPresent = false
    const managedEvents = new Set<string>(COPILOT_EVENTS)
    for (const eventName of COPILOT_EVENTS) {
      const command = getManagedCommand(scriptPath, eventName)
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      const hasCurrentCommand = definitions.some((definition) =>
        definitionHasCurrentCommand(definition, command)
      )
      if (hasCurrentCommand) {
        presentCount += 1
      } else {
        missing.push(eventName)
      }
    }
    for (const [eventName, definitions] of Object.entries(config.hooks ?? {})) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const currentCommand = managedEvents.has(eventName)
        ? getManagedCommand(scriptPath, eventName)
        : null
      staleManagedPresent =
        staleManagedPresent ||
        definitions.some((definition) =>
          definitionHasStaleManagedCommand(definition, currentCommand, isManagedCommand)
        )
    }

    const managedHooksPresent = presentCount > 0 || staleManagedPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (config.disableAllHooks === true && managedHooksPresent) {
      state = 'partial'
      detail = 'Managed Copilot hook file is disabled'
    } else if (staleManagedPresent) {
      state = 'partial'
      detail = 'Managed Copilot hook file contains stale entries'
    } else if (missing.length === 0) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0 && !staleManagedPresent) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'copilot', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Copilot hooks/orca.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(COPILOT_EVENTS)
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    for (const eventName of COPILOT_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      nextHooks[eventName] = [
        ...cleaned,
        getManagedHookDefinition(getManagedCommand(scriptPath, eventName))
      ]
    }

    config.version = 1
    delete config.disableAllHooks
    config.hooks = nextHooks
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    return installCopilotHooksRemote(sftp, remoteHome)
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) {
      return this.getStatus()
    }
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Copilot hooks/orca.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    let changed = false
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      changed = changed || definitionsChanged(definitions, cleaned)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    if (!changed) {
      return this.getStatus()
    }
    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const copilotHookService = new CopilotHookService()
