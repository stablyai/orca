import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { buildPosixAgentHookPostCommand } from './hook-post-command'

export function posixHookResponseFallback(expression = "'{}'"): string[] {
  return [`orca_hook_response=${expression}`, `trap 'printf "%s\\n" "$orca_hook_response"' EXIT`]
}

export function posixContextHookPost(source: AgentHookSource): string[] {
  return [
    'post_context_hook() {',
    ...buildPosixAgentHookPostCommand(source, { contextResponse: true }),
    '}',
    'if orca_hook_reply=$(post_context_hook 2>/dev/null); then',
    '  if [ -n "$orca_hook_reply" ]; then orca_hook_response=$orca_hook_reply; fi',
    'else',
    '  spool_hook_event',
    'fi'
  ]
}

export function windowsContextHookScript(body: string[], fallback: string): string {
  return [
    '@echo off',
    'setlocal',
    'if not defined TEMP goto :orca_context_fallback',
    'set "orca_context_dir=%TEMP%\\orca-context-%RANDOM%-%RANDOM%"',
    'mkdir "%orca_context_dir%" 2>nul',
    'if errorlevel 1 goto :orca_context_fallback',
    'call :orca_context_run',
    'if not exist "%orca_context_dir%\\response.json" goto :orca_context_cleanup',
    'for %%I in ("%orca_context_dir%\\response.json") do if %%~zI EQU 0 goto :orca_context_cleanup',
    'type "%orca_context_dir%\\response.json"',
    'del /q "%orca_context_dir%\\response.json" 2>nul',
    'rmdir "%orca_context_dir%" 2>nul',
    'exit /b 0',
    ':orca_context_cleanup',
    'del /q "%orca_context_dir%\\response.json" 2>nul',
    'rmdir "%orca_context_dir%" 2>nul',
    ':orca_context_fallback',
    fallback,
    'exit /b 0',
    ':orca_context_run',
    ...body
  ].join('\r\n')
}

export const WINDOWS_CONTEXT_POST_FAILURE =
  'if errorlevel 1 del /q "%orca_context_dir%\\response.json" 2>nul'
