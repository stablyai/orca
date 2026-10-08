import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'
import { WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD } from './hook-stdin-contract'
import {
  wrapWindowsPowerShellEncodedCommand,
  type WindowsPowerShellHookOptions
} from './windows-powershell-hook-launcher'

export function wrapWindowsHookCommand(
  scriptPath: string,
  env: Record<string, string> = {},
  options: WindowsPowerShellHookOptions & { fallbackStdout?: string } = {}
): string {
  return wrapWindowsPowerShellEncodedCommand(
    buildWindowsHookPowerShellCommand(scriptPath, env, options),
    options
  )
}

export function buildWindowsHookPowerShellCommand(
  scriptPath: string,
  env: Record<string, string> = {},
  // Why: POSIX wrap already answers missing-script with stdout; Windows must match so gate events cannot drift (#15462).
  options: { fallbackStdout?: string } = {}
): string {
  // Why: the encoded launcher protects paths across Windows shells and drains stdin when the config points at a missing script.
  const quoted = quotePowerShellLiteral(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `$env:${key} = ${quotePowerShellLiteral(value)}; `)
    .join('')
  const fallback =
    options.fallbackStdout === undefined
      ? ''
      : `Write-Output ${quotePowerShellLiteral(options.fallbackStdout)}; `
  // Why the order: answer first (a gate event reads silence as deny), then the shared
  // env guard, and only then own stdin — outside an Orca pane the caller may abandon the
  // pipe, and ReadToEnd would strand the launcher there forever (#11549).
  return `${envPrefix}if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; ${fallback}${WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD}; [Console]::In.ReadToEnd() | Out-Null; exit 0`
}

export const WINDOWS_CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\~-]+$/

export function isSafeUnicodeWindowsBatchHookPath(scriptPath: string): boolean {
  return (
    !WINDOWS_CMD_SAFE_PATH.test(scriptPath) && /^[\p{L}\p{N}\p{M}_.:\\~-]+\.cmd$/iu.test(scriptPath)
  )
}

export function wrapWindowsCmdHookCommand(scriptPath: string): string {
  // Direct-spawn consumers need one executable token; a cmd `if exist` fragment is not one (#8430).
  if (WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
    return scriptPath
  }
  // Unicode batch hooks keep the missing-file guard without loading the policy cmdlet.
  return wrapWindowsHookCommand(
    scriptPath,
    {},
    {
      useProcessPolicyEnvironment: isSafeUnicodeWindowsBatchHookPath(scriptPath)
    }
  )
}
