import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    // Why: we can't tell PowerShell, Git Bash or cmd.exe apart; double quotes only differ on `$` and
    // backticks, which single quotes keep literal in PowerShell and Git Bash (agents' shells).
    return /[$`]/.test(value) ? quotePowerShellLiteral(value) : `"${value.replace(/"/g, '\\"')}"`
  }
  return quotePosixShell(value)
}
