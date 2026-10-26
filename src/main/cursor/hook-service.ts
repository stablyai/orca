import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandDefinition,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { CURSOR_EVENTS } from './hook-events'
import { getManagedCommand, getManagedScript, getPosixManagedCommand } from './hook-script'

function getConfigPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'cursor-hook.cmd' : 'cursor-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

export class CursorHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const missing: string[] = []
    let presentCount = 0
    for (const eventName of CURSOR_EVENTS) {
      const command = getManagedCommand(scriptPath, eventName)
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      // Accept both Cursor's direct command and legacy nested Claude-shaped definitions.
      const hasCommand = definitions.some(
        (definition) =>
          definition.command === command ||
          (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(eventName)
      }
    }
    const managedHooksPresent = presentCount > 0
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'cursor', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(CURSOR_EVENTS)

    // Match filenames to catch older builds and moved user-data paths.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    // Remove managed hooks from retired events so upgrades stop invoking them.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      const strippedTopLevelCommands = cleaned.filter(
        (definition) => !isManagedCommand(definition.command)
      )
      if (strippedTopLevelCommands.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = strippedTopLevelCommands
      }
    }

    for (const eventName of CURSOR_EVENTS) {
      const command = getManagedCommand(scriptPath, eventName)
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand).filter(
        (definition) => !isManagedCommand(definition.command)
      )
      // Cursor requires command directly on the definition.
      const definition: HookDefinition = buildManagedCommandDefinition(command)
      nextHooks[eventName] = [...cleaned, definition]
    }

    // Cursor requires version 1; preserve user-pinned versions.
    const nextConfig: Record<string, unknown> = { ...config, hooks: nextHooks }
    if (nextConfig.version === undefined) {
      nextConfig.version = 1
    }
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Remote installs must match local hook behavior while using POSIX paths.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = `${remoteHome.replace(/\/$/, '')}/.cursor/hooks.json`
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/cursor-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'cursor',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Cursor hooks.json'
        }
      }

      const nextHooks = { ...config.hooks }
      const isManagedCommand = createManagedCommandMatcher('cursor-hook.sh')

      for (const eventName of CURSOR_EVENTS) {
        const command = getPosixManagedCommand(remoteScriptPath, eventName)
        const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
        // Remove both schema shapes so repeated installs converge on one entry.
        const cleaned = removeManagedCommands(current, isManagedCommand).filter(
          (definition) => !isManagedCommand(definition.command)
        )
        const definition: HookDefinition = buildManagedCommandDefinition(command)
        nextHooks[eventName] = [...cleaned, definition]
      }

      const nextConfig: Record<string, unknown> = { ...config, hooks: nextHooks }
      if (nextConfig.version === undefined) {
        nextConfig.version = 1
      }

      // Write the POSIX script before config so partial installs cannot reference a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)

      return {
        agent: 'cursor',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand).filter(
        (definition) => !isManagedCommand(definition.command)
      )
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    const nextConfig = { ...config, hooks: nextHooks }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }
}

export const cursorHookService = new CursorHookService()
