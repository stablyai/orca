import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'

export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}
