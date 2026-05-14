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

// Why: cursor-agent exposes a declarative hooks.json surface at
// ~/.cursor/hooks.json (https://cursor.com/docs/hooks) with camelCase event
// names. We subscribe to the minimum set that drives the sidebar spinner and
// turn-boundary detection:
//   - beforeSubmitPrompt: new turn starts (carries the user's prompt)
//   - stop:               turn ends (→ done)
//   - preToolUse/postToolUse/postToolUseFailure: in-flight tool preview
//     between submit and stop — without these the pane appears idle for the
//     entire duration of a long tool-heavy turn
//   - beforeShellExecution / beforeMCPExecution: approval prompts (→ waiting)
//   - afterAgentResponse: carries the final composed reply text so the
//     dashboard can surface it on done
// sessionStart / sessionEnd are intentionally NOT subscribed — cursor-agent
// fires them at process lifetime boundaries rather than at turn boundaries,
// and sessionStart's fire-time can race the first beforeSubmitPrompt in a
// way that would reset the prompt cache for the just-submitted turn.
const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
] as const

function getConfigPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'cursor-hook.cmd' : 'cursor-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32' ? scriptPath : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: see claude/hook-service.ts for rationale. The endpoint file holds
      // the live port/token for this Orca install; sourcing it here lets a
      // surviving PTY reach the current server even though its env points at
      // the prior Orca's coordinates.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }; try { $body=@{ paneKey=$env:ORCA_PANE_KEY; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; env=$env:ORCA_AGENT_HOOK_ENV; version=$env:ORCA_AGENT_HOOK_VERSION; payload=($inputData | ConvertFrom-Json) } | ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/cursor') -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $body | Out-Null } catch {}"`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: see claude/hook-service.ts for rationale. Sourcing refreshes
    // PORT/TOKEN/ENV/VERSION from the current Orca so a surviving PTY keeps
    // reporting after a restart.
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
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/cursor" \\',
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

export class CursorHookService {
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

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of CURSOR_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      // Why: Cursor's schema places the command directly on the definition
      // (not nested under a `hooks` array as Claude does), so match both
      // shapes to stay robust against future schema changes.
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

    const command = getManagedCommand(scriptPath)
    // Why: Cursor's hooks.json wraps the map under a top-level "hooks" key
    // (same as Claude/Codex). A fresh file with no prior hook install will
    // have config.hooks === undefined.
    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(CURSOR_EVENTS)

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds or a different
    // Electron userData path (dev vs. prod). Without this, repeated installs
    // accumulate duplicate hook entries pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    // Why: sweep managed entries out of events we no longer subscribe to
    // (e.g. a future rename where we drop an event name). Without this,
    // users who already had that event registered would keep firing stale
    // hooks after the app upgrade.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      // Also strip entries with the command at the top level (Cursor schema).
      const strippedCursorShape = cleaned.filter(
        (definition) => !isManagedCommand(definition.command as string | undefined)
      )
      if (strippedCursorShape.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = strippedCursorShape
      }
    }

    for (const eventName of CURSOR_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      // Sweep both the Claude-shaped (hooks[].command) and Cursor-shaped
      // (definition.command) variants so repeated installs converge on a
      // single managed entry.
      const cleaned = removeManagedCommands(current, isManagedCommand).filter(
        (definition) => !isManagedCommand(definition.command as string | undefined)
      )
      // Why: Cursor's documented schema puts `command` directly on the
      // definition (not under `hooks`). Emit that shape so cursor-agent
      // actually invokes the script.
      const definition: HookDefinition = { command }
      nextHooks[eventName] = [...cleaned, definition]
    }

    // Why: cursor-agent's config schema requires a top-level `version: 1`
    // (see https://cursor.com/docs/hooks). Preserve an existing value if the
    // user has already pinned one, otherwise stamp the default so a fresh
    // install produces a valid file. HooksConfig has an index signature on
    // extra keys, so assign via a Record-typed object to satisfy the type.
    const nextConfig: Record<string, unknown> = { ...config, hooks: nextHooks }
    if (nextConfig.version === undefined) {
      nextConfig.version = 1
    }
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
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
        (definition) => !isManagedCommand(definition.command as string | undefined)
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
