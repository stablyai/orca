import { quotePowerShellLiteral } from '../../shared/shell/launch/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    // Why: single quotes keep `$`, backticks and `"` literal in PowerShell and Git Bash (agents' shells),
    // but cmd.exe would run operators outside them, so values with one keep cmd-safe double quotes.
    return /[$`"\u201C-\u201E]/.test(value) && !/[&|<>^\r\n]/.test(value)
      ? quotePowerShellLiteral(value)
      : `"${value.replace(/"/g, '\\"')}"`
  }
  return quotePosixShell(value)
}
