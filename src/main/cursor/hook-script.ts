import {
  buildWindowsAgentHookPostCommand,
  wrapPosixHookCommand,
  wrapWindowsHookCommand
} from '../agent-hooks/installer-utils'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/grok-replay-guard'
import { CURSOR_EVENTS, getCursorHookResponse, type CursorEvent } from './hook-events'

const CURSOR_HOOK_RESPONSE_ENV = 'ORCA_CURSOR_HOOK_RESPONSE'

export function getPosixManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  const response = getCursorHookResponse(eventName)
  return wrapPosixHookCommand(
    scriptPath,
    { [CURSOR_HOOK_RESPONSE_ENV]: response },
    { fallbackStdout: response }
  )
}

export function getManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  if (process.platform !== 'win32') {
    return getPosixManagedCommand(scriptPath, eventName)
  }
  // Why: PowerShell 5.1 recodes hook stdin through the ANSI code page, so the notification
  // body is mojibake on a non-UTF-8 Windows locale. A cmd-safe profile runs the .cmd
  // directly, as Claude does (#18875), and passes the event name so permission hooks still
  // answer (#15462). A path with spaces still needs the encoded launcher (#6078).
  const directScript = wrapWindowsDirectCmdHookCommand(scriptPath)
  if (directScript) {
    return `${directScript} ${eventName}`
  }
  const response = getCursorHookResponse(eventName)
  return wrapWindowsHookCommand(
    scriptPath,
    { [CURSOR_HOOK_RESPONSE_ENV]: response },
    { fallbackStdout: response }
  )
}

// Why: one .cmd serves every Cursor event, and permission hooks fail closed on `{}` (#15462).
// The event name is a single shell-safe argument, so cmd.exe and Git Bash can both run the
// command without PowerShell sitting on stdin.
function buildWindowsCursorResponseLines(): string[] {
  const lines = CURSOR_EVENTS.map((eventName, index) => {
    const keyword = index === 0 ? 'if' : ') else if'
    return `${keyword} /I "%~1"=="${eventName}" (echo ${getCursorHookResponse(eventName)}`
  })
  lines.push(`) else if defined ${CURSOR_HOOK_RESPONSE_ENV} (echo %${CURSOR_HOOK_RESPONSE_ENV}%`)
  lines.push(') else (echo {})')
  return lines
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
      // %~1 is the direct-launch event; the env var is the PowerShell fallback for unsafe paths.
      ...buildWindowsCursorResponseLines(),
      // Why: source current endpoint coordinates for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      ...buildWindowsGrokReplayGuardLines(),
      buildWindowsAgentHookPostCommand('cursor'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
    `if [ -n "$${CURSOR_HOOK_RESPONSE_ENV}" ]; then`,
    `  printf '%s\\n' "$${CURSOR_HOOK_RESPONSE_ENV}"`,
    'else',
    '  printf "{}\\n"',
    'fi',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixGrokReplayGuardLines(),
    ...buildPosixHookSpoolLines('cursor'),
    // Why: refresh endpoint coordinates so surviving PTYs keep reporting.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: post form fields because path-bearing worktree IDs are unsafe in hand-built JSON.
    // Why: pipe payload to curl stdin to keep large output off the command line.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/cursor" \\',
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
