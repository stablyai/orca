import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installer-utils'

const WINDOWS_FORM_FIELDS = [
  ['hook_event_name', 'ORCA_CODEWHALE_HOOK_EVENT'],
  ['deepseekToolName', 'DEEPSEEK_TOOL_NAME'],
  ['deepseekToolArgs', 'DEEPSEEK_TOOL_ARGS'],
  ['deepseekToolResult', 'DEEPSEEK_TOOL_RESULT'],
  ['deepseekToolExitCode', 'DEEPSEEK_TOOL_EXIT_CODE'],
  ['deepseekToolSuccess', 'DEEPSEEK_TOOL_SUCCESS'],
  ['deepseekError', 'DEEPSEEK_ERROR'],
  ['deepseekSessionId', 'DEEPSEEK_SESSION_ID'],
  ['deepseekMessage', 'DEEPSEEK_MESSAGE'],
  ['deepseekWorkspace', 'DEEPSEEK_WORKSPACE'],
  ['deepseekModel', 'DEEPSEEK_MODEL'],
  ['deepseekTotalTokens', 'DEEPSEEK_TOTAL_TOKENS']
] as const

export function getManagedCodeWhaleWindowsScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
    'if not defined ORCA_AGENT_HOOK_PORT exit /b 0',
    'if not defined ORCA_AGENT_HOOK_TOKEN exit /b 0',
    'if not defined ORCA_PANE_KEY exit /b 0',
    // Why: CodeWhale observer hooks expose state through DEEPSEEK_* env vars and
    // may inherit TUI stdin. Use the shared curl helper in file-field mode so
    // cmd.exe never parses JSON/metachar env values and curl never reads stdin.
    buildWindowsAgentHookPostCommand('codewhale', {
      extraEnvFileFields: WINDOWS_FORM_FIELDS,
      payload: { kind: 'literal', value: '{}' },
      tempDirEnvName: 'ORCA_CODEWHALE_FORM_DIR',
      tempDirPrefix: 'orca-codewhale-hook'
    }),
    'exit /b 0',
    ''
  ].join('\r\n')
}
