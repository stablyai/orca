import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { quotePowerShellLiteral } from '../../shared/shell/launch/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import { resolveWindowsShellStartupFamily } from '../../shared/shell/launch/windows-terminal-shell'

function resolveWindowsCliShell(env: NodeJS.ProcessEnv): AgentStartupShell {
  const configured = env.ORCA_TERMINAL_WINDOWS_SHELL ?? env.ORCA_WINDOWS_SHELL
  if (configured?.trim()) {
    return resolveWindowsShellStartupFamily(configured)
  }
  if (env.MSYSTEM) {
    return 'posix'
  }
  // cmd.exe sets PROMPT without a POSIX SHELL; PowerShell launched directly leaves PROMPT unset.
  if (env.PROMPT && !env.SHELL) {
    return 'cmd'
  }
  return 'powershell'
}

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    const shell = resolveWindowsCliShell(process.env)
    if (shell === 'cmd') {
      return quoteWindowsCmdArgument(value)
    }
    if (shell === 'posix') {
      return quotePosixShell(value)
    }
    // Why: single quotes keep `$`, backticks and `"` literal in PowerShell,
    // while values with cmd operators keep double quotes.
    return /[$`"\u201C-\u201E]/.test(value) && !/[&|<>^\r\n]/.test(value)
      ? quotePowerShellLiteral(value)
      : `"${value.replace(/"/g, '\\"')}"`
  }
  return quotePosixShell(value)
}
