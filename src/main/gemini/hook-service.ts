import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'

// Why: Gemini CLI fires `BeforeAgent` when a turn starts and `AfterAgent` when
// it completes. `AfterTool` marks the resumption of model work after a tool
// call, which maps back to `working`. Gemini has no permission-prompt hook
// (approvals flow through inline UI), so Orca cannot surface a waiting state
// for Gemini — that is an upstream limitation, not an Orca bug.
//
// PreToolUse surfaces the current tool name + input preview (e.g.
// `read_file: src/foo.ts`) so long-running tool calls aren't a silent gap
// between BeforeAgent and AfterAgent. PostToolUse is intentionally omitted —
// AfterTool already signals "back to working" and the tool name from
// PreToolUse is what we show; PostToolUse would be a redundant fire.
const GEMINI_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'PreToolUse'] as const

function getConfigPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
}

function getManagedScriptPath(): string {
  return join(app.getPath('userData'), 'agent-hooks', getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32' ? scriptPath : `/bin/sh "${scriptPath}"`
}

function getManagedScript(): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Gemini expects valid JSON on stdout even when the hook has nothing
      // to return. Emit `{}` first so the agent never stalls parsing our
      // output, even if the env-var guards below cause an early exit.
      'echo {}',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }; try { $body=@{ paneKey=$env:ORCA_PANE_KEY; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; env=$env:ORCA_AGENT_HOOK_ENV; version=$env:ORCA_AGENT_HOOK_VERSION; payload=($inputData | ConvertFrom-Json) } | ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/gemini') -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $body | Out-Null } catch {}"`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: Gemini expects valid JSON on stdout even when the hook has nothing
    // to return. Emit `{}` first so the agent never stalls parsing our output,
    // even if the env-var guards below cause an early exit.
    'printf "{}\\n"',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/gemini" \\',
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

export class GeminiHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of GEMINI_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      const hasCommand = definitions.some((definition) =>
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
    return { agent: 'gemini', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextHooks = { ...config.hooks }

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds or a different
    // Electron userData path (dev vs. prod). Without this, repeated installs
    // accumulate duplicate hook entries pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    for (const eventName of GEMINI_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        hooks: [{ type: 'command', command }]
      }
      nextHooks[eventName] = [...cleaned, definition]
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
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: same broad matcher as install(), so remove() also cleans up stale
    // entries from older builds even if the current scriptPath has moved.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      // Why: a malformed settings.json entry (non-array value for an event
      // name) would make removeManagedCommands throw via definitions.flatMap.
      // Skip — remove() must fail open so a broken user config never blocks
      // uninstall.
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

export const geminiHookService = new GeminiHookService()
