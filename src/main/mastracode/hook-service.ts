import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  readHooksJson,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'

export const MASTRACODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'AgentStart',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PermissionResult',
  'AgentEnd',
  'Stop',
  'Interrupt',
  'SessionEnd'
] as const

function getConfigPath(): string {
  return join(homedir(), '.mastracode', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'mastracode-hook.cmd' : 'mastracode-hook.sh'
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
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('mastracode'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('mastracode'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/mastracode" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

function readEventDefinitions(config: HooksConfig, eventName: string): unknown[] {
  const value = config[eventName]
  return Array.isArray(value) ? value : []
}

function hasManagedCommand(value: unknown, matches: (command?: string) => boolean): boolean {
  return (
    isPlainObject(value) && matches(typeof value.command === 'string' ? value.command : undefined)
  )
}

function removeManagedEntries(
  definitions: readonly unknown[],
  matches: (command?: string) => boolean
): unknown[] {
  return definitions.filter((definition) => !hasManagedCommand(definition, matches))
}

export function applyManagedMastraCodeHooks(
  config: HooksConfig,
  command: string,
  scriptFileName: string
): void {
  const matches = createManagedCommandMatcher(scriptFileName)
  const events = new Set<string>(MASTRACODE_HOOK_EVENTS)

  for (const [eventName, definitions] of Object.entries(config)) {
    if (events.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedEntries(definitions, matches)
    if (cleaned.length === 0) {
      delete config[eventName]
    } else {
      config[eventName] = cleaned
    }
  }

  for (const eventName of MASTRACODE_HOOK_EVENTS) {
    config[eventName] = [
      ...removeManagedEntries(readEventDefinitions(config, eventName), matches),
      {
        type: 'command',
        command,
        timeout: MANAGED_HOOK_TIMEOUT_MILLISECONDS,
        description: 'Report agent status to Orca'
      }
    ]
  }
}

function removeManagedMastraCodeHooks(config: HooksConfig, scriptFileName: string): void {
  const matches = createManagedCommandMatcher(scriptFileName)
  for (const [eventName, definitions] of Object.entries(config)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedEntries(definitions, matches)
    if (cleaned.length === 0) {
      delete config[eventName]
    } else {
      config[eventName] = cleaned
    }
  }
}

function buildStatus(config: HooksConfig, configPath: string): AgentHookInstallStatus {
  const matches = createManagedCommandMatcher(getManagedScriptFileName())
  const missing = MASTRACODE_HOOK_EVENTS.filter(
    (eventName) =>
      !readEventDefinitions(config, eventName).some((entry) => hasManagedCommand(entry, matches))
  )
  const presentCount = MASTRACODE_HOOK_EVENTS.length - missing.length
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
  return {
    agent: 'mastracode',
    state,
    configPath,
    managedHooksPresent: presentCount > 0,
    detail
  }
}

export class MastraCodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'mastracode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Mastra Code hooks.json'
      }
    }
    return buildStatus(config, configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'mastracode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Mastra Code hooks.json'
      }
    }
    const scriptPath = getManagedScriptPath()
    applyManagedMastraCodeHooks(config, getManagedCommand(scriptPath), getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const configPath = `${home}/.mastracode/hooks.json`
    const scriptPath = `${home}/.orca/agent-hooks/mastracode-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, configPath)
      if (!config) {
        return {
          agent: 'mastracode',
          state: 'error',
          configPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Mastra Code hooks.json'
        }
      }
      applyManagedMastraCodeHooks(config, wrapPosixHookCommand(scriptPath), 'mastracode-hook.sh')
      await writeManagedScriptRemote(sftp, scriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, configPath, config)
      return {
        agent: 'mastracode',
        state: 'installed',
        configPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return {
        agent: 'mastracode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'mastracode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Mastra Code hooks.json'
      }
    }
    removeManagedMastraCodeHooks(config, getManagedScriptFileName())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const mastraCodeHookService = new MastraCodeHookService()
