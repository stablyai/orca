import { quotePowerShellSingleQuoted } from '../../shared/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    // Why: PowerShell, Git Bash and cmd.exe read double quotes alike except for `$` and backticks;
    // single quotes keep those literal in PowerShell and Git Bash, the shells agents run.
    return /[$`]/.test(value)
      ? quotePowerShellSingleQuoted(value)
      : `"${value.replace(/"/g, '\\"')}"`
  }
  return quotePosixShell(value)
}
