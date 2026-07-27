// The managed Claude hook script body Orca installs into settings.json. Split
// from `hook-service.ts` to keep the service under the max-lines budget; the
// lifecycle logic (install/remove/remote) stays there.

import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue,
  WINDOWS_HOOK_STDIN_DRAIN_LABEL
} from '../agent-hooks/hook-stdin-contract'

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: { skipWhenDevinImportsClaude?: boolean } = {}
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Why: Devin imports only the default Claude hooks; alternate config-dir launches still need their own status.
            'if "%DEVIN_PROJECT_DIR%"=="" goto :orca_devin_guard_done',
            `if "%CLAUDE_CONFIG_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`,
            `for %%I in ("%CLAUDE_CONFIG_DIR%") do if /I "%%~nxI"==".claude" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`,
            ':orca_devin_guard_done'
          ]
        : []),
      // Why: call the endpoint file to refresh port/token — a PTY that survived an Orca restart carries stale env; falls through to PTY env if missing.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      // Why: avoid a second PowerShell startup and identify the config-dir flavor without exposing credentials.
      buildWindowsAgentHookCurlPostCommand('claude', ['configDir=%CLAUDE_CONFIG_DIR%']),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Why: Devin imports only the default Claude hooks; alternate config-dir launches still need their own status.
          'orca_claude_config_dir=${CLAUDE_CONFIG_DIR%/}',
          'if [ -n "$DEVIN_PROJECT_DIR" ] && { [ -z "$orca_claude_config_dir" ] || [ "${orca_claude_config_dir##*/}" = ".claude" ]; }; then',
          '  exit 0',
          'fi'
        ]
      : []),
    // Why: source the endpoint file to refresh port/token — a PTY that survived an Orca restart carries stale env; falls back to PTY env if missing.
    // Why: suppress stderr / || : so a stray parse error (TOCTOU or CRLF) can't leak into hook output or trip an outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: paths can hold quotes/newlines, so hand-building JSON in shell is unsafe; post the raw payload + metadata as form fields for the receiver to parse.
    // Why: pipe payload to curl stdin (`payload@-`), not an inline arg, so large tool output stays off the command line (EDR false positives).
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    // Why: identifies which CLAUDE_CONFIG_DIR flavor posted (path string only —
    // never tokens). Empty for default installs and ignored by the server;
    // pre-update scripts that omit the field behave identically.
    '  --data-urlencode "configDir=${CLAUDE_CONFIG_DIR}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}
