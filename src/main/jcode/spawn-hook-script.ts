import { JCODE_SPAWN_HOOK_PATHNAME } from '../../shared/jcode-spawn-hook'
import { buildWindowsHookEnvironmentGuardLines } from '../agent-hooks/hook-stdin-contract'

const SPAWN_FORM_FIELDS = [
  ['paneKey', 'ORCA_PANE_KEY'],
  ['paneSecret', 'ORCA_JCODE_PANE_SECRET'],
  ['worktreeId', 'ORCA_WORKTREE_ID'],
  ['kind', 'JCODE_SPAWN_KIND'],
  ['command', 'JCODE_SPAWN_COMMAND'],
  ['sessionId', 'JCODE_SPAWN_SESSION_ID'],
  ['coordinatorSessionId', 'JCODE_SPAWN_COORDINATOR_SESSION_ID'],
  ['title', 'JCODE_SPAWN_TITLE'],
  ['cwd', 'JCODE_SPAWN_CWD'],
  ['runtimeDir', 'JCODE_RUNTIME_DIR']
] as const

const FAILURE_MESSAGE = 'orca: jcode spawn hook was not accepted by Orca'

export function buildJcodeSpawnHookScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal EnableDelayedExpansion',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines().map((line) =>
        line.replace('exit /b 0', 'goto :orca_spawn_failed')
      ),
      'if not defined ORCA_JCODE_PANE_SECRET goto :orca_spawn_failed',
      'if not defined JCODE_SPAWN_SESSION_ID goto :orca_spawn_failed',
      `"%SystemRoot%\\System32\\curl.exe" -sS --fail -X POST "http://127.0.0.1:!ORCA_AGENT_HOOK_PORT!${JCODE_SPAWN_HOOK_PATHNAME}" ^`,
      '  --noproxy 127.0.0.1 --connect-timeout 0.5 --max-time 1.6 ^',
      '  -H "X-Orca-Agent-Hook-Token: !ORCA_AGENT_HOOK_TOKEN!" ^',
      ...SPAWN_FORM_FIELDS.map(
        ([field, variable]) => `  --data-urlencode "${field}=!${variable}!" ^`
      ),
      '  >nul 2>nul',
      'if errorlevel 1 goto :orca_spawn_failed',
      'exit /b 0',
      ':orca_spawn_failed',
      `>&2 echo ${FAILURE_MESSAGE}`,
      'exit /b 1',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'orca_spawn_failed() {',
    `  printf '%s\\n' '${FAILURE_MESSAGE}' >&2`,
    '  exit 1',
    '}',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ] || [ -z "$ORCA_JCODE_PANE_SECRET" ] || [ -z "$JCODE_SPAWN_SESSION_ID" ]; then',
    '  orca_spawn_failed',
    'fi',
    `status=$(printf '%s' "$ORCA_JCODE_PANE_SECRET" | curl -sS --fail -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}${JCODE_SPAWN_HOOK_PATHNAME}" \\`,
    '  --noproxy 127.0.0.1 --connect-timeout 0.5 --max-time 1.6 \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    ...SPAWN_FORM_FIELDS.map(([field, variable]) =>
      field === 'paneSecret'
        ? '  --data-urlencode "paneSecret@-" \\'
        : `  --data-urlencode "${field}=\${${variable}}" \\`
    ),
    "  -o /dev/null -w '%{http_code}' 2>/dev/null) || orca_spawn_failed",
    'case "$status" in',
    '  2??) exit 0 ;;',
    '  *) orca_spawn_failed ;;',
    'esac',
    ''
  ].join('\n')
}
