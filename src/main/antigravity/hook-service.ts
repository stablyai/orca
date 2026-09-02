import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  getSharedManagedScriptPath,
  readHooksJson,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  ANTIGRAVITY_EVENTS,
  ANTIGRAVITY_PRE_TOOL_USE_DECISION,
  type AntigravityEvent
} from './hook-events'
import { getManagedScript, getWindowsWrapperScript } from './hook-script'
import {
  buildInstalledConfig,
  bundleHasStaleManagedCommand,
  createAntigravityManagedCommandMatcher,
  getBundle,
  hasManagedCommand,
  removeInstalledConfig
} from './hooks-json-bundle'

function getConfigPath(): string {
  // Why: Antigravity's hook docs define global hooks in ~/.gemini/config/hooks.json,
  // not in the CLI settings file used by Gemini CLI.
  return join(homedir(), '.gemini', 'config', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getWindowsWrapperScriptPath(event: AntigravityEvent): string {
  return getSharedManagedScriptPath(event.windowsWrapperFileName)
}

function getPosixManagedCommand(scriptPath: string, event: AntigravityEvent): string {
  return wrapPosixHookCommand(
    scriptPath,
    { ORCA_ANTIGRAVITY_EVENT: event.eventName },
    // Why: a missing managed script must not brick tools; the guard answers PreToolUse itself instead of staying silent.
    event.eventName === 'PreToolUse' ? { fallbackStdout: ANTIGRAVITY_PRE_TOOL_USE_DECISION } : {}
  )
}

function getManagedCommand(scriptPath: string, event: AntigravityEvent): string {
  if (process.platform === 'win32') {
    return wrapWindowsCmdHookCommand(getWindowsWrapperScriptPath(event))
  }
  return getPosixManagedCommand(scriptPath, event)
}

export class AntigravityHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
    if (process.platform === 'win32') {
      for (const event of ANTIGRAVITY_EVENTS) {
        await refreshManagedScriptIfPresent(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
    }
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    const bundle = getBundle(config)
    const isManagedCommand = createAntigravityManagedCommandMatcher()
    const currentCommands = new Set(
      ANTIGRAVITY_EVENTS.map((event) => getManagedCommand(scriptPath, event))
    )
    const staleManagedPresent = bundleHasStaleManagedCommand(
      bundle,
      isManagedCommand,
      currentCommands
    )
    const missing: string[] = []
    let presentCount = 0
    for (const event of ANTIGRAVITY_EVENTS) {
      const definitions = Array.isArray(bundle[event.eventName])
        ? (bundle[event.eventName] as HookDefinition[])
        : []
      if (hasManagedCommand(definitions, getManagedCommand(scriptPath, event))) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }

    const managedHooksPresent = presentCount > 0 || staleManagedPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && !staleManagedPresent) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0 && !staleManagedPresent) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail =
        missing.length > 0
          ? `Managed hook missing for events: ${missing.join(', ')}`
          : 'Stale managed hook entries need cleanup'
    }
    return { agent: 'antigravity', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    buildInstalledConfig(
      config,
      (event) => getManagedCommand(scriptPath, event),
      createAntigravityManagedCommandMatcher()
    )
    writeManagedScript(scriptPath, getManagedScript())
    if (process.platform === 'win32') {
      // Why: Antigravity wraps hook commands in cmd.exe. Keeping event env
      // setup inside event-specific .cmd files avoids nested hooks.json quotes.
      for (const event of ANTIGRAVITY_EVENTS) {
        writeManagedScript(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
    }
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.gemini/config/hooks.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/antigravity-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'antigravity',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Antigravity hooks.json'
        }
      }

      buildInstalledConfig(
        config,
        (event) => getPosixManagedCommand(remoteScriptPath, event),
        createAntigravityManagedCommandMatcher()
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'antigravity',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'antigravity',
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
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    removeInstalledConfig(config)
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const antigravityHookService = new AntigravityHookService()
