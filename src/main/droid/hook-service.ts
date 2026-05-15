import { homedir } from 'os'
import { join } from 'path'
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

// Why: SessionStart is installed (not just listened for) so that resuming a
// droid session via `droid --resume` resets the per-pane prompt/tool caches
// without waiting for the next UserPromptSubmit. Mirrors the codex pattern in
// src/main/codex/hook-service.ts.
const DROID_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  // Why: Droid approval prompts are emitted at PermissionRequest, including
  // low-impact Edit approvals that have no riskLevel marker on PreToolUse.
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Notification', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

function getConfigPath(): string {
  return join(homedir(), '.factory', 'settings.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'droid-hook.cmd' : 'droid-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  // Why: Factory invokes the .cmd directly via cmd.exe (no bash), so native
  // backslashes are correct on Windows. Matches the codex/cursor pattern.
  return process.platform === 'win32' ? scriptPath : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }; try { $body=@{ paneKey=$env:ORCA_PANE_KEY; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; env=$env:ORCA_AGENT_HOOK_ENV; version=$env:ORCA_AGENT_HOOK_VERSION; payload=($inputData | ConvertFrom-Json) } | ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/droid') -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $body | Out-Null } catch {}"`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
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
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/droid" \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

export class DroidHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'droid',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Factory settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of DROID_EVENTS) {
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
    // Why: surface hooksDisabled across every branch — without this, a
    // disabled-AND-partially-installed (or disabled-AND-not-installed) state
    // would silently swallow the disabled flag and the user would think a
    // re-install fixed it.
    if (missing.length === 0) {
      if (config.hooksDisabled === true) {
        state = 'partial'
        detail = 'Droid hooks are disabled in Factory settings'
      } else {
        state = 'installed'
        detail = null
      }
    } else if (presentCount === 0) {
      if (config.hooksDisabled === true) {
        state = 'partial'
        detail = 'Droid hooks are disabled in Factory settings'
      } else {
        state = 'not_installed'
        detail = null
      }
    } else {
      state = 'partial'
      detail =
        config.hooksDisabled === true
          ? `Droid hooks are disabled in Factory settings; managed hook missing for events: ${missing.join(', ')}`
          : `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'droid', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'droid',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Factory settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    const managedEvents = new Set<string>(DROID_EVENTS.map((event) => event.eventName))

    // Why: sweep managed entries out of events we no longer subscribe to.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
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

    for (const event of DROID_EVENTS) {
      const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        ...event.definition,
        hooks: [{ type: 'command', command }]
      }
      nextHooks[event.eventName] = [...cleaned, definition]
    }

    config.hooks = nextHooks
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'droid',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Factory settings.json'
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

export const droidHookService = new DroidHookService()
