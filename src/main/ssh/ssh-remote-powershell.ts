import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'

export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Why: Windows PowerShell 5.1 does not preserve embedded double quotes when
// passing args to native executables, so pre-escape them for Win32 argv parsing.
export function powerShellNativeArg(value: string): string {
  return powerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}

export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}
