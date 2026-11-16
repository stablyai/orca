import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'
import { quotePowerShellLiteral } from '../../shared/shell/launch/powershell-native-argument'
import { parseJsonRecord } from './zotz-json-record'
import type { ZotzProcessRunner } from './zotz-process-runner'

export type ZotzElevationResult =
  | { launched: true; exitCode: number | null }
  | { launched: false; cancelled: boolean; detail: string }

// ERROR_CANCELLED: the user declined the UAC prompt.
const UAC_DECLINED = 1223

export function windowsArgumentLine(args: readonly string[]): string {
  return args.map(quoteWindowsArgument).join(' ')
}

/** One UAC prompt; the hidden elevated child is awaited and only its exit code comes back. */
export function buildWindowsElevationScript(filePath: string, argumentLine: string): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath ${quotePowerShellLiteral(filePath)} -ArgumentList ${quotePowerShellLiteral(argumentLine)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  [pscustomobject]@{ launched = $true; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ launched = $false; nativeErrorCode = $_.Exception.NativeErrorCode; message = $_.Exception.Message } | ConvertTo-Json -Compress
}`
}

export function parseWindowsElevationOutput(stdout: string): ZotzElevationResult {
  const parsed = parseJsonRecord(stdout)
  if (!parsed) {
    return {
      launched: false,
      cancelled: false,
      detail: stdout.trim() || 'no answer from PowerShell'
    }
  }
  if (parsed.launched === true) {
    return {
      launched: true,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null
    }
  }
  return {
    launched: false,
    cancelled: parsed.nativeErrorCode === UAC_DECLINED,
    detail: typeof parsed.message === 'string' ? parsed.message : 'elevation failed'
  }
}

export async function runElevatedWindowsProcess(
  run: ZotzProcessRunner,
  env: NodeJS.ProcessEnv,
  filePath: string,
  args: readonly string[],
  timeoutMs: number
): Promise<ZotzElevationResult> {
  const result = await run(
    windowsPowerShellPath(env),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildWindowsElevationScript(filePath, windowsArgumentLine(args))
    ],
    timeoutMs
  )
  return parseWindowsElevationOutput(result.stdout)
}
