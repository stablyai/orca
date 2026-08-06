import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installer-utils'
import {
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

/** Matches the envelope length cap used by the POSIX grok-hook branch. */
export const GROK_HOME_ENVELOPE_MAX_LENGTH = 4096

const WINDOWS_GROK_HOOK_POST_COMMAND = buildWindowsAgentHookPostCommand('grok', [
  // Why: attach grokHome before payload@- without string-replacing the shared template.
  '  --data-urlencode "grokHome=%ORCA_GROK_HOME%" ^'
])

/**
 * Windows `grok-hook.cmd` body.
 *
 * Why (#9358 / #9941): cmd expands `%VAR:~n,m%` at parse time. When `GROK_HOME`
 * is unset (the default outside an Orca-managed terminal), length/trailing
 * guards become a syntax error and every Grok hook event fails with exit 255.
 *
 * - Guard substring ops behind `if defined` + goto (not a parenthesized block).
 * - Reject oversized values before copying them onto a cmd input line.
 */
export function buildWindowsGrokHookScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
    ...buildWindowsHookEnvironmentGuardLines(),
    'set "ORCA_GROK_HOME="',
    'if not defined GROK_HOME goto :orca_grok_home_ready',
    `if not "%GROK_HOME:~${GROK_HOME_ENVELOPE_MAX_LENGTH},1%"=="" goto :orca_grok_home_ready`,
    'set "ORCA_GROK_HOME=%GROK_HOME%"',
    'if not defined ORCA_GROK_HOME goto :orca_grok_home_ready',
    'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."',
    // Why: the trailing-backslash safety sentinel counts toward the relay envelope.
    `if not "%ORCA_GROK_HOME:~${GROK_HOME_ENVELOPE_MAX_LENGTH},1%"=="" set "ORCA_GROK_HOME="`,
    ':orca_grok_home_ready',
    WINDOWS_GROK_HOOK_POST_COMMAND,
    'exit /b 0',
    ...buildWindowsHookStdinDrainEpilogue(),
    ''
  ].join('\r\n')
}
