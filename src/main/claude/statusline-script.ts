import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { CLAUDE_STATUSLINE_PATHNAME } from '../../shared/claude-statusline-rate-limits'

// Why: Claude Code pipes `rate_limits` to the statusLine command on every turn; forwarding
// it gives Orca live usage without spending the OAuth usage endpoint's tight budget.
// Emits no stdout so the in-terminal status line stays visually unchanged.
export function getManagedStatusLineScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: call the endpoint file to refresh port/token — a PTY that survived an Orca restart carries stale env; falls through to PTY env if missing.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      [
        '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
        `"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%${CLAUDE_STATUSLINE_PATHNAME}"`,
        '--connect-timeout 0.5 --max-time 1.5',
        '-H "Content-Type: application/x-www-form-urlencoded"',
        '-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"',
        '--data-urlencode "paneKey=%ORCA_PANE_KEY%"',
        '--data-urlencode "configDir=%CLAUDE_CONFIG_DIR%"',
        '--data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"',
        '--data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"',
        '--data-urlencode "payload@-"',
        '>nul 2>&1'
      ].join(' '),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    // Why: rate_limits appears only for Claude.ai-subscriber sessions after the first API response; skip the post (and its curl spawn) otherwise.
    'case "$payload" in',
    '  *\'"rate_limits"\'*) ;;',
    '  *) exit 0 ;;',
    'esac',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    `printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}${CLAUDE_STATUSLINE_PATHNAME}" \\`,
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "configDir=${CLAUDE_CONFIG_DIR}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}
