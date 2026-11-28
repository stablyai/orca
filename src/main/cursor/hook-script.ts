import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installation/commands/windows-agent-hook-post-command'
import { wrapPosixHookCommand } from '../agent-hooks/installation/commands/posix-hook-command'
import { getSharedManagedScriptPath } from '../agent-hooks/installation/scripts/managed-hook-script-path'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import { posixCurlCommand } from '../agent-hooks/installation/scripts/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines
} from '../agent-hooks/installation/scripts/hook-stdin-contract'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/installation/scripts/grok-replay-guard'
import { quoteStartupArg } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { getCursorHookResponse, type CursorEvent } from './hook-events'

const CURSOR_HOOK_RESPONSE_ENV = 'ORCA_CURSOR_HOOK_RESPONSE'
// Cursor fires these on nearly every agent event, so each one spawned a PowerShell + conhost.
const CURSOR_WINDOWS_EVENT_ENV = 'ORCA_CURSOR_HOOK_EVENT'

export function getPosixManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  const response = getCursorHookResponse(eventName)
  return wrapPosixHookCommand(
    scriptPath,
    { [CURSOR_HOOK_RESPONSE_ENV]: response },
    { fallbackStdout: response }
  )
}

/** One wrapper per event carries Cursor's event name and reply to the shared script. */
export function getWindowsCursorWrapperScriptPath(eventName: CursorEvent): string {
  return getSharedManagedScriptPath(`cursor-${eventName}.cmd`)
}

export function getWindowsCursorWrapperScript(eventName: CursorEvent): string {
  return [
    '@echo off',
    // Preserve literal ! characters in the percent-expanded core path.
    'setlocal DisableDelayedExpansion',
    `set "${CURSOR_HOOK_RESPONSE_ENV}=${getCursorHookResponse(eventName)}"`,
    `set "${CURSOR_WINDOWS_EVENT_ENV}=${eventName}"`,
    'set "ORCA_CURSOR_HOOK_CORE=%~dp0cursor-hook.cmd"',
    'if exist "%ORCA_CURSOR_HOOK_CORE%" (',
    '  call "%ORCA_CURSOR_HOOK_CORE%"',
    '  exit /b 0',
    ')',
    `echo %${CURSOR_HOOK_RESPONSE_ENV}%`,
    ...buildWindowsHookEnvironmentGuardLines(),
    'exit /b 0',
    ''
  ].join('\r\n')
}

export function getManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  if (process.platform !== 'win32') {
    // Cursor uses the login shell; wrap the POSIX guard in sh with portable quoting.
    return `/bin/sh -c ${quoteStartupArg(getPosixManagedCommand(scriptPath, eventName), 'posix')}`
  }
  // Cursor runs a plain command directly: registering the wrapper skips the per-event
  // PowerShell + conhost flash. Spaced or non-ASCII paths keep the encoded launcher.
  return wrapWindowsBatchHookCommand(getWindowsCursorWrapperScriptPath(eventName))
}

export function getWindowsManagedScript(): string {
  return [
    '@echo off',
    'setlocal',
    // Cursor permission hooks reject empty or invalid stdout (#15462).
    `if defined ${CURSOR_HOOK_RESPONSE_ENV} (echo %${CURSOR_HOOK_RESPONSE_ENV}%) else (echo {})`,
    // Refresh endpoints for PTYs that survived an Orca restart.
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
    ...buildWindowsHookEnvironmentGuardLines(),
    ...buildWindowsGrokReplayGuardLines(),
    // The wrapper names the event; Cursor's own payload does not carry it as hook_event_name.
    buildWindowsAgentHookPostCommand('cursor', [
      `  --data-urlencode "hookEventName=%${CURSOR_WINDOWS_EVENT_ENV}%" ^`
    ]),
    'exit /b 0',
    ''
  ].join('\r\n')
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return getWindowsManagedScript()
  }

  return [
    '#!/bin/sh',
    // Cursor permission hooks reject empty or invalid stdout (#15462).
    `if [ -n "$${CURSOR_HOOK_RESPONSE_ENV}" ]; then`,
    `  printf '%s\\n' "$${CURSOR_HOOK_RESPONSE_ENV}"`,
    'else',
    '  printf "{}\\n"',
    'fi',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixGrokReplayGuardLines(),
    ...buildPosixHookSpoolLines('cursor'),
    // Refresh endpoints for PTYs that survived an Orca restart.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Form encoding handles path-bearing IDs; stdin keeps large payloads off the command line.
    `printf '%s' "$payload" | ${posixCurlCommand()} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/cursor" \\`,
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
