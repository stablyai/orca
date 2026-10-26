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
  // Match POSIX fallback answers so missing-script gate events cannot default to denial.
  options: { fallbackStdout?: string } = {}
): string {
  const quoted = quotePowerShellLiteral(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `$env:${key} = ${quotePowerShellLiteral(value)}; `)
    .join('')
  const fallback =
    options.fallbackStdout === undefined
      ? ''
      : `Write-Output ${quotePowerShellLiteral(options.fallbackStdout)}; `
  // Answer gates before checking Orca context, then guard ReadToEnd against abandoned stdin.
  return `${envPrefix}if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; ${fallback}${WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD}; [Console]::In.ReadToEnd() | Out-Null; exit 0`
}

export const WINDOWS_CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\~-]+$/

export function isSafeUnicodeWindowsBatchHookPath(scriptPath: string): boolean {
  return (
    !WINDOWS_CMD_SAFE_PATH.test(scriptPath) && /^[\p{L}\p{N}\p{M}_.:\\~-]+\.cmd$/iu.test(scriptPath)
  )
}
