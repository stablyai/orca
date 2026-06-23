/* eslint-disable max-lines */
import { homedir } from 'os'
import { join } from 'path'
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
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

const COMMAND_CODE_EVENTS = [
  {
    eventName: 'PreToolUse',
    definition: { matcher: '.*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '.*', hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

function getConfigPath(): string {
  return join(homedir(), '.commandcode', 'settings.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'command-code-hook.cmd' : 'command-code-hook.sh'
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
      'if "%ORCA_AGENT_HOOK_PORT%"=="" if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" if not "%ORCA_AGENT_HOOK_PORT%"=="" call :sourceEndpointByPort',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookPostCommand('command-code'),
      'exit /b 0',
      ':sourceEndpointByPort',
      'if not defined APPDATA exit /b 0',
      'if exist "%APPDATA%\\orca-dev\\agent-hooks" for /r "%APPDATA%\\orca-dev\\agent-hooks" %%F in (endpoint.cmd) do call :maybeSourceEndpoint "%%~fF"',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" if exist "%APPDATA%\\orca\\agent-hooks" for /r "%APPDATA%\\orca\\agent-hooks" %%F in (endpoint.cmd) do call :maybeSourceEndpoint "%%~fF"',
      'exit /b 0',
      ':maybeSourceEndpoint',
      'if not "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'for /f "tokens=2 delims==" %%P in (\'findstr /b /c:"set ORCA_AGENT_HOOK_PORT=" "%~1" 2^>nul\') do if "%%P"=="%ORCA_AGENT_HOOK_PORT%" call "%~1" 2>nul',
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    '__orca_read_ancestor_var() {',
    '  __orca_name="$1"',
    '  __orca_pid="${PPID:-}"',
    '  while [ -n "$__orca_pid" ] && [ "$__orca_pid" != "0" ] && [ "$__orca_pid" != "1" ]; do',
    '    __orca_value=""',
    '    if [ -r "/proc/$__orca_pid/environ" ]; then',
    '      __orca_value=$(tr "\\000" "\\n" < "/proc/$__orca_pid/environ" 2>/dev/null | sed -n "s/^${__orca_name}=//p" | head -n 1)',
    '    fi',
    '    if [ -z "$__orca_value" ]; then',
    '      __orca_value=$(ps eww -p "$__orca_pid" -o command= 2>/dev/null | tr " " "\\n" | sed -n "s/^${__orca_name}=//p" | head -n 1)',
    '    fi',
    '    if [ -n "$__orca_value" ]; then',
    '      printf "%s\\n" "$__orca_value"',
    '      return 0',
    '    fi',
    '    __orca_pid=$(ps -o ppid= -p "$__orca_pid" 2>/dev/null | tr -d " ")',
    '  done',
    '  return 1',
    '}',
    '__orca_fill_from_ancestor() {',
    '  __orca_name="$1"',
    '  case "$__orca_name" in',
    '    ORCA_AGENT_HOOK_ENDPOINT) [ -z "${ORCA_AGENT_HOOK_ENDPOINT:-}" ] || return 0 ;;',
    '    ORCA_AGENT_HOOK_PORT) [ -z "${ORCA_AGENT_HOOK_PORT:-}" ] || return 0 ;;',
    '    ORCA_AGENT_HOOK_TOKEN) [ -z "${ORCA_AGENT_HOOK_TOKEN:-}" ] || return 0 ;;',
    '    ORCA_AGENT_HOOK_ENV) [ -z "${ORCA_AGENT_HOOK_ENV:-}" ] || return 0 ;;',
    '    ORCA_AGENT_HOOK_VERSION) [ -z "${ORCA_AGENT_HOOK_VERSION:-}" ] || return 0 ;;',
    '    ORCA_PANE_KEY) [ -z "${ORCA_PANE_KEY:-}" ] || return 0 ;;',
    '    ORCA_TAB_ID) [ -z "${ORCA_TAB_ID:-}" ] || return 0 ;;',
    '    ORCA_WORKTREE_ID) [ -z "${ORCA_WORKTREE_ID:-}" ] || return 0 ;;',
    '    ORCA_AGENT_LAUNCH_TOKEN) [ -z "${ORCA_AGENT_LAUNCH_TOKEN:-}" ] || return 0 ;;',
    '    *) return 0 ;;',
    '  esac',
    '  __orca_value=$(__orca_read_ancestor_var "$__orca_name") || return 0',
    '  [ -n "$__orca_value" ] && export "$__orca_name=$__orca_value"',
    '}',
    '__orca_endpoint_value() {',
    '  __orca_endpoint_name="$1"',
    '  __orca_endpoint_path="$2"',
    '  sed -n "s/^${__orca_endpoint_name}=//p" "$__orca_endpoint_path" 2>/dev/null | head -n 1',
    '}',
    '__orca_fill_from_endpoint_file() {',
    '  __orca_endpoint_path="$1"',
    '  [ -r "$__orca_endpoint_path" ] || return 0',
    '  __orca_endpoint_port=$(__orca_endpoint_value ORCA_AGENT_HOOK_PORT "$__orca_endpoint_path")',
    '  if [ -n "${ORCA_AGENT_HOOK_PORT:-}" ] && [ -n "$__orca_endpoint_port" ] && [ "$__orca_endpoint_port" != "$ORCA_AGENT_HOOK_PORT" ]; then',
    '    return 0',
    '  fi',
    '  for __orca_endpoint_name in ORCA_AGENT_HOOK_PORT ORCA_AGENT_HOOK_TOKEN ORCA_AGENT_HOOK_ENV ORCA_AGENT_HOOK_VERSION; do',
    '    eval "__orca_current=\\${$__orca_endpoint_name:-}"',
    '    [ -z "$__orca_current" ] || continue',
    '    __orca_endpoint_value=$(__orca_endpoint_value "$__orca_endpoint_name" "$__orca_endpoint_path")',
    '    [ -n "$__orca_endpoint_value" ] && export "$__orca_endpoint_name=$__orca_endpoint_value"',
    '  done',
    '}',
    '# Why: Command Code sanitizes hook subprocess env. The parent TUI process',
    '# still has Orca pane/hook metadata, so recover it before posting.',
    'for __orca_name in ORCA_AGENT_HOOK_ENDPOINT ORCA_AGENT_HOOK_PORT ORCA_AGENT_HOOK_TOKEN ORCA_AGENT_HOOK_ENV ORCA_AGENT_HOOK_VERSION ORCA_PANE_KEY ORCA_TAB_ID ORCA_WORKTREE_ID ORCA_AGENT_LAUNCH_TOKEN; do',
    '  __orca_fill_from_ancestor "$__orca_name"',
    'done',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  __orca_fill_from_endpoint_file "$ORCA_AGENT_HOOK_ENDPOINT"',
    'fi',
    '# Why: Command Code strips TOKEN-like env vars before invoking hooks. If',
    '# ORCA_AGENT_HOOK_ENDPOINT was not exported into this PTY, recover the',
    '# matching endpoint file by the unstripped loopback port.',
    'if [ -z "$ORCA_AGENT_HOOK_TOKEN" ] && [ -n "$ORCA_AGENT_HOOK_PORT" ]; then',
    '  for endpoint in \\',
    '    "$HOME/Library/Application Support/orca-dev/agent-hooks"/*/endpoint.env \\',
    '    "$HOME/Library/Application Support/orca-dev/agent-hooks/endpoint.env" \\',
    '    "${XDG_CONFIG_HOME:-$HOME/.config}/orca-dev/agent-hooks"/*/endpoint.env \\',
    '    "${XDG_CONFIG_HOME:-$HOME/.config}/orca-dev/agent-hooks/endpoint.env" \\',
    '    "$HOME/Library/Application Support/orca/agent-hooks/endpoint.env" \\',
    '    "${XDG_CONFIG_HOME:-$HOME/.config}/orca/agent-hooks/endpoint.env"; do',
    '    [ -r "$endpoint" ] || continue',
    '    endpoint_port=$(sed -n "s/^ORCA_AGENT_HOOK_PORT=//p" "$endpoint" | head -n 1)',
    '    if [ "$endpoint_port" = "$ORCA_AGENT_HOOK_PORT" ]; then',
    '      __orca_fill_from_endpoint_file "$endpoint"',
    '      break',
    '    fi',
    '  done',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/command-code" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function buildInstalledConfig(
  config: NonNullable<ReturnType<typeof readHooksJson>>,
  command: string,
  scriptFileName: string
): void {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const managedEvents = new Set<string>(COMMAND_CODE_EVENTS.map((event) => event.eventName))

  // Why: Orca owns only command-code-hook.* entries. Sweep retired managed
  // events while preserving user-authored Command Code hooks.
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

  for (const event of COMMAND_CODE_EVENTS) {
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

export class CommandCodeHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'command-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Command Code settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of COMMAND_CODE_EVENTS) {
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
    return { agent: 'command-code', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'command-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Command Code settings.json'
      }
    }

    buildInstalledConfig(config, getManagedCommand(scriptPath), getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.commandcode/settings.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/command-code-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'command-code',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Command Code settings.json'
        }
      }

      buildInstalledConfig(config, wrapPosixHookCommand(remoteScriptPath), 'command-code-hook.sh')
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'command-code',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'command-code',
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
        agent: 'command-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Command Code settings.json'
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

export const commandCodeHookService = new CommandCodeHookService()
