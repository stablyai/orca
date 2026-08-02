import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'
export {
  quotePowerShellLiteral as powerShellLiteral,
  quotePowerShellNativeArgument as powerShellNativeArg
} from '../../shared/powershell-native-argument'

export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}
