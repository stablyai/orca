import { quotePowerShellSingleQuoted } from '../../shared/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    // Why: PowerShell expands `$`, escapes with backticks and doesn't take `\"`; single quotes keep
    // those literal in PowerShell and Git Bash, the shells agents run.
    return /[$`"\u201C-\u201E]/.test(value) ? quotePowerShellSingleQuoted(value) : `"${value}"`
  }
  return quotePosixShell(value)
}
