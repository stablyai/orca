import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  buildPosixManagedHookScript,
  buildWindowsEndpointLoadLine,
  buildWindowsEndpointSubroutineLines
} from '../agent-hooks/managed-hook-script'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

const GROK_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SessionEnd', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Notification', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

function getConfigPath(): string {
  // Why: Grok loads trusted global hook files from ~/.grok/hooks/*.json. Keep
  // Orca's managed entries in a dedicated file so user-authored hook files stay
  // untouched and project-level trust is not required for status reporting.
  return join(homedir(), '.grok', 'hooks', 'orca-status.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: see claude/hook-service.ts. The endpoint file is parsed (never
      // executed) to refresh live coordinates after an Orca restart.
      buildWindowsEndpointLoadLine(),
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookPostCommand('grok'),
      'exit /b 0',
      ...buildWindowsEndpointSubroutineLines(),
      ''
    ].join('\r\n')
  }

  return buildPosixManagedHookScript({ source: 'grok' })
}

function buildInstalledConfig(
  config: NonNullable<ReturnType<typeof readHooksJson>>,
  command: string,
  scriptFileName: string
): void {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const managedEvents = new Set<string>(GROK_EVENTS.map((event) => event.eventName))

  // Why: Orca owns only grok-hook.* entries. Sweep stale managed commands out
  // of retired events while preserving any user-authored hooks in this file.
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

  for (const event of GROK_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  config.hooks = nextHooks
}

export class GrokHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of GROK_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
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
    return { agent: 'grok', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    buildInstalledConfig(config, getManagedCommand(scriptPath), getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.grok/hooks/orca-status.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/grok-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'grok',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Grok hook config'
        }
      }

      buildInstalledConfig(config, wrapPosixHookCommand(remoteScriptPath), 'grok-hook.sh')
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'grok',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'grok',
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
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const grokHookService = new GrokHookService()
