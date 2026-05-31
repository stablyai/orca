/* eslint-disable max-lines -- Why: local status/install/remove and SSH remote
   install must share the same Copilot event list, script body, and
   managed-command matching so local and remote hook behavior cannot drift. */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

// Why: Copilot's user-level hook files can use VS Code-compatible PascalCase
// names, which match the event vocabulary already normalized by Orca's hook
// server and avoid wrapper-side event remapping.
const COPILOT_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  // Why: GitHub's current reference documents subagentStart with only the
  // camelCase payload shape. The wrapper passes the event name separately, so
  // Orca can normalize it without depending on a PascalCase payload.
  'subagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'ErrorOccurred',
  'PermissionRequest',
  'Notification'
] as const

function getCopilotHome(): string {
  const fromEnv = process.env.COPILOT_HOME?.trim()
  return fromEnv ? fromEnv : join(homedir(), '.copilot')
}

function getConfigPath(): string {
  return join(getCopilotHome(), 'hooks', 'orca.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'copilot-hook.ps1' : 'copilot-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function quotePowerShellPath(path: string): string {
  return `'${path.replaceAll("'", "''")}'`
}

function getManagedCommand(scriptPath: string, eventName: string): string {
  return process.platform === 'win32'
    ? `$env:ORCA_COPILOT_HOOK_EVENT = '${eventName}'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quotePowerShellPath(scriptPath)}`
    : wrapPosixHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
}

function getManagedHookDefinition(command: string): HookDefinition {
  return process.platform === 'win32'
    ? { type: 'command', powershell: command, timeoutSec: 5 }
    : { type: 'command', bash: command, timeoutSec: 5 }
}

function getRemoteManagedHookDefinition(command: string): HookDefinition {
  return { type: 'command', bash: command, timeoutSec: 5 }
}

function definitionHasCurrentCommand(definition: HookDefinition, command: string): boolean {
  return (
    definition.command === command ||
    definition.bash === command ||
    definition.powershell === command ||
    (Array.isArray(definition.hooks) && definition.hooks.some((hook) => hook.command === command))
  )
}

function definitionHasStaleManagedCommand(
  definition: HookDefinition,
  currentCommand: string | null,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  const commands = [definition.command, definition.bash, definition.powershell]
  if (commands.some((command) => isManagedCommand(command) && command !== currentCommand)) {
    return true
  }
  return (
    Array.isArray(definition.hooks) &&
    definition.hooks.some(
      (hook) => isManagedCommand(hook.command) && hook.command !== currentCommand
    )
  )
}

function definitionsChanged(before: HookDefinition[], after: HookDefinition[]): boolean {
  return (
    before.length !== after.length ||
    after.some((definition, index) => definition !== before[index])
  )
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      "Write-Output '{}'",
      // Why: endpoint.cmd is cmd syntax, not PowerShell. Parse its `set KEY=...`
      // lines so surviving PTYs can refresh to the current Orca server.
      'if ($env:ORCA_AGENT_HOOK_ENDPOINT -and (Test-Path -LiteralPath $env:ORCA_AGENT_HOOK_ENDPOINT)) {',
      '  try {',
      '    Get-Content -LiteralPath $env:ORCA_AGENT_HOOK_ENDPOINT | ForEach-Object {',
      "      if ($_ -match '^set ([A-Za-z0-9_]+)=(.*)$') {",
      "        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')",
      '      }',
      '    }',
      '  } catch {}',
      '}',
      'if (-not $env:ORCA_AGENT_HOOK_PORT -or -not $env:ORCA_AGENT_HOOK_TOKEN -or -not $env:ORCA_PANE_KEY) { exit 0 }',
      '$inputData = [Console]::In.ReadToEnd()',
      'if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }',
      'try {',
      '  $payload = $inputData | ConvertFrom-Json',
      '  $body = @{',
      '    paneKey = $env:ORCA_PANE_KEY',
      '    tabId = $env:ORCA_TAB_ID',
      '    worktreeId = $env:ORCA_WORKTREE_ID',
      '    hookEventName = $env:ORCA_COPILOT_HOOK_EVENT',
      '    env = $env:ORCA_AGENT_HOOK_ENV',
      '    version = $env:ORCA_AGENT_HOOK_VERSION',
      '    payload = $payload',
      '  } | ConvertTo-Json -Depth 100',
      "  Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/copilot') -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $body -TimeoutSec 2 | Out-Null",
      '} catch {}',
      'exit 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    "printf '{}\\n'",
    // Why: Copilot consumes stdout for some hooks, so stdout is emitted before
    // endpoint refresh, stdin parsing, or the network POST can fail.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/copilot" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "hookEventName=${ORCA_COPILOT_HOOK_EVENT}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

export class CopilotHookService {
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
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.copilot/hooks/orca.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/copilot-hook.sh`

    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'copilot',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Copilot hooks/orca.json'
        }
      }

      const nextHooks = { ...config.hooks }
      const managedEvents = new Set<string>(COPILOT_EVENTS)
      const isManagedCommand = createManagedCommandMatcher('copilot-hook.sh')

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
          getRemoteManagedHookDefinition(
            wrapPosixHookCommand(remoteScriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
          )
        ]
      }

      config.version = 1
      delete config.disableAllHooks
      config.hooks = nextHooks
      // Why: SSH remotes use POSIX scripts regardless of Orca's local OS. Write
      // the script before hooks/orca.json so a partial install cannot point
      // Copilot at a missing managed command.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'copilot',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
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
