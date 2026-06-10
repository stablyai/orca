import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'

export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Why: Windows PowerShell 5.1 does not escape embedded double quotes when
// passing arguments to native executables, so the Win32 argv parser eats them
// (e.g. node -e 'require("net")' arrives as require(net)). Pre-escaping with
// backslashes survives the PS→native boundary. Backslashes directly before a
// quote must be doubled per Win32 command-line parsing rules.
export function powerShellNativeArg(value: string): string {
  return powerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}

export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}
