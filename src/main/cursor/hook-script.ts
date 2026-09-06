import {
  buildWindowsAgentHookCurlPostCommand,
  wrapPosixHookCommand,
  wrapWindowsHookCommand
} from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { getCursorHookResponse, type CursorEvent } from './hook-events'
import {
  posixContextHookPost,
  posixHookResponseFallback,
  windowsContextHookScript,
  WINDOWS_CONTEXT_POST_FAILURE
} from '../agent-hooks/hook-context-response-script'

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
  const response = getCursorHookResponse(eventName)
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(
        scriptPath,
        { [CURSOR_HOOK_RESPONSE_ENV]: response },
        { fallbackStdout: response }
      )
    : getPosixManagedCommand(scriptPath, eventName)
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return windowsContextHookScript(
      [
        // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
        // Why: source current endpoint coordinates for PTYs surviving an Orca restart.
        'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
        ...buildWindowsHookEnvironmentGuardLines(),
        buildWindowsAgentHookCurlPostCommand('cursor', true),
        WINDOWS_CONTEXT_POST_FAILURE,
        'exit /b 0',
        ...buildWindowsHookStdinDrainEpilogue(),
        ''
      ],
      `if defined ${CURSOR_HOOK_RESPONSE_ENV} (echo %${CURSOR_HOOK_RESPONSE_ENV}%) else (echo {})`
    )
  }

  return [
    '#!/bin/sh',
    // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
    ...posixHookResponseFallback(),
    `if [ -n "$${CURSOR_HOOK_RESPONSE_ENV}" ]; then orca_hook_response=$${CURSOR_HOOK_RESPONSE_ENV}; fi`,
    ...buildPosixHookPayloadCapture(),
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
    ...posixContextHookPost('cursor'),
    'exit 0',
    ''
  ].join('\n')
}
