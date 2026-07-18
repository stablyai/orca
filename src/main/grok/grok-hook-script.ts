import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// Envelope bound shared with the hook listener's grokHome validation; a home
// longer than this is dropped rather than forwarded.
export const GROK_HOME_ENVELOPE_MAX_LENGTH = 4096

const WINDOWS_HOOK_PAYLOAD_FORM_LINE = '  --data-urlencode "payload@-" >nul 2>nul'

const WINDOWS_GROK_HOOK_POST_COMMAND = buildWindowsAgentHookPostCommand('grok').replace(
  WINDOWS_HOOK_PAYLOAD_FORM_LINE,
  `  --data-urlencode "grokHome=%ORCA_GROK_HOME%" ^\r\n${WINDOWS_HOOK_PAYLOAD_FORM_LINE}`
)

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    // Why: cmd.exe expands %VAR% before evaluating `if` chains, so
    // `if defined X if "%X:~-1%"=="\"` still parse-errors when X is empty.
    // Goto keeps the trailing-backslash check on a line that is only reached
    // when a non-empty ORCA_GROK_HOME exists (Grok defaults to unset
    // GROK_HOME / ~/.grok; Orca panes always set PORT/TOKEN/PANE so we do
    // not early-exit via the stdin drain).
    const grokHomeReadyLabel = 'orca_grok_home_ready'
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      'set "ORCA_GROK_HOME="',
      `if not defined GROK_HOME goto :${grokHomeReadyLabel}`,
      'set "ORCA_GROK_HOME=%GROK_HOME%"',
      `if not "%GROK_HOME:~${GROK_HOME_ENVELOPE_MAX_LENGTH},1%"=="" set "ORCA_GROK_HOME="`,
      `if not defined ORCA_GROK_HOME goto :${grokHomeReadyLabel}`,
      // Why: a trailing backslash escapes curl's closing argv quote on Windows,
      // merging the payload option into grokHome and dropping the hook body.
      'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."',
      `:${grokHomeReadyLabel}`,
      WINDOWS_GROK_HOOK_POST_COMMAND,
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'grok_home=',
    `if [ -n "\${GROK_HOME:-}" ] && [ "\${#GROK_HOME}" -le ${GROK_HOME_ENVELOPE_MAX_LENGTH} ]; then`,
    '  grok_home=$GROK_HOME',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/grok" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "grokHome=${grok_home}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}
