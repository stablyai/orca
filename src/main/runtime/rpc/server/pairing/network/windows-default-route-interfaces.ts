import { execFile } from 'node:child_process'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'

const POWERSHELL_TIMEOUT_MS = 3_000

type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string>

export type WindowsDefaultRouteEnvironment = {
  platform: NodeJS.Platform
  systemRoot?: string
  runPowerShell?: PowerShellRunner
}

export async function getWindowsDefaultRouteInterfaceNames(
  environment: WindowsDefaultRouteEnvironment = {
    platform: process.platform
  }
): Promise<ReadonlySet<string> | null> {
  if (environment.platform !== 'win32') {
    return new Set()
  }

  try {
    const stdout = await (
      environment.runPowerShell ?? createPowerShellRunner(environment.systemRoot)
    )(buildDefaultRouteScript(), POWERSHELL_TIMEOUT_MS)
    const parsed = JSON.parse(stdout.trim()) as unknown
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) {
      return null
    }
    return new Set(parsed)
  } catch {
    return null
  }
}

function buildDefaultRouteScript(): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$names = @(Get-NetRoute -ErrorAction Stop | Where-Object { $_.State -eq 'Alive' -and ($_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0') } | Select-Object -ExpandProperty InterfaceAlias -Unique)
ConvertTo-Json -InputObject $names -Compress`
}

function createPowerShellRunner(systemRoot?: string): PowerShellRunner {
  const powershellPath = windowsPowerShellPath(
    systemRoot === undefined ? undefined : { SystemRoot: systemRoot }
  )
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error)
          } else {
            resolve(stdout)
          }
        }
      )
    })
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}
