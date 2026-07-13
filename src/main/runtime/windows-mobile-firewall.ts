import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type {
  WindowsMobileFirewallRepairResult,
  WindowsMobileFirewallStatus,
  WindowsNetworkCategory
} from '../../shared/windows-mobile-firewall'

const FIREWALL_RULE_NAME = 'Orca.MobilePairing'
const FIREWALL_RULE_DISPLAY_NAME = 'Orca Mobile Pairing'
const POWERSHELL_TIMEOUT_MS = 10_000
const ELEVATION_TIMEOUT_MS = 5 * 60_000

type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string>

export type WindowsMobileFirewallEnvironment = {
  platform: NodeJS.Platform
  isPackaged: boolean
  executablePath: string
  systemRoot?: string
  runPowerShell?: PowerShellRunner
}

type FirewallInspection = {
  ruleAllowed: boolean
  privateFirewallEnabled: boolean
  networkCategory: string
}

type ElevationResult = {
  launched: boolean
  exitCode?: number
  nativeErrorCode?: number
}

export async function inspectWindowsMobileFirewall(
  port: number | null,
  address: string | undefined,
  environment: WindowsMobileFirewallEnvironment = defaultEnvironment()
): Promise<WindowsMobileFirewallStatus> {
  if (!isSupported(environment, port)) {
    return { supported: false }
  }

  try {
    const stdout = await getRunner(environment)(
      buildInspectionScript(port, environment.executablePath, address),
      POWERSHELL_TIMEOUT_MS
    )
    const result = JSON.parse(stdout.trim()) as FirewallInspection
    return {
      supported: true,
      port,
      ruleAllowed: result.ruleAllowed === true,
      privateFirewallEnabled: result.privateFirewallEnabled !== false,
      networkCategory: parseNetworkCategory(result.networkCategory),
      inspectionAvailable: true
    }
  } catch {
    // Why: firewall inspection is advisory; unavailable PowerShell or managed
    // policy must not block pairing or remove the explicit repair option.
    return unavailableStatus(port)
  }
}

export async function repairWindowsMobileFirewall(
  port: number | null,
  environment: WindowsMobileFirewallEnvironment = defaultEnvironment()
): Promise<WindowsMobileFirewallRepairResult> {
  if (!isSupported(environment, port)) {
    return { ok: false, reason: 'unsupported' }
  }

  const powershellPath = getWindowsPowerShellPath(environment.systemRoot)
  const elevatedScript = buildRepairScript(port, environment.executablePath)
  const outerScript = buildElevationScript(powershellPath, encodePowerShell(elevatedScript))
  try {
    const stdout = await getRunner(environment)(outerScript, ELEVATION_TIMEOUT_MS)
    const result = JSON.parse(stdout.trim()) as ElevationResult
    if (!result.launched && result.nativeErrorCode === 1223) {
      return { ok: false, reason: 'cancelled' }
    }
    return result.launched && result.exitCode === 0 ? { ok: true } : { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

export function getWebSocketPort(endpoint: string | null): number | null {
  if (!endpoint) {
    return null
  }
  try {
    const parsed = new URL(endpoint)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

function defaultEnvironment(): WindowsMobileFirewallEnvironment {
  return {
    platform: process.platform,
    // Why: direct helper calls must fail closed; the IPC integration opts in
    // only after Electron confirms this is a packaged Windows build.
    isPackaged: false,
    executablePath: process.execPath,
    systemRoot: process.env.SystemRoot
  }
}

function isSupported(
  environment: WindowsMobileFirewallEnvironment,
  port: number | null
): port is number {
  // Why: development Electron paths are transient and must never be persisted
  // into an elevated firewall rule that outlives the checkout.
  return environment.platform === 'win32' && environment.isPackaged && port !== null
}

function unavailableStatus(port: number): WindowsMobileFirewallStatus {
  return {
    supported: true,
    port,
    ruleAllowed: false,
    privateFirewallEnabled: true,
    networkCategory: 'unknown',
    inspectionAvailable: false
  }
}

function parseNetworkCategory(value: string): WindowsNetworkCategory {
  if (value === 'Private') {
    return 'private'
  }
  if (value === 'Public') {
    return 'public'
  }
  if (value === 'DomainAuthenticated') {
    return 'domain'
  }
  return 'unknown'
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function buildInspectionScript(port: number, executablePath: string, address?: string): string {
  const addressLookup = address
    ? `
try {
  $ip = Get-NetIPAddress -IPAddress ${quotePowerShell(address)} -ErrorAction Stop | Select-Object -First 1
  $profile = Get-NetConnectionProfile -InterfaceIndex $ip.InterfaceIndex -ErrorAction Stop | Select-Object -First 1
  if ($profile) { $networkCategory = [string]$profile.NetworkCategory }
} catch {}`
    : ''
  return `$ErrorActionPreference = 'Stop'
$ruleAllowed = $false
$rules = @(Get-NetFirewallApplicationFilter -Program ${quotePowerShell(executablePath)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
foreach ($rule in $rules) {
  $portFilter = $rule | Get-NetFirewallPortFilter
  $protocol = [string]$portFilter.Protocol
  $profile = [string]$rule.Profile
  $portMatches = @($portFilter.LocalPort | Where-Object { [string]$_ -eq 'Any' -or [string]$_ -eq '${port}' }).Count -gt 0
  if (($protocol -eq 'Any' -or $protocol -eq 'TCP' -or $protocol -eq '6') -and ($profile -eq 'Any' -or $profile -match 'Private') -and $portMatches) {
    $ruleAllowed = $true
  }
}
$privateFirewallEnabled = [bool](Get-NetFirewallProfile -Name Private).Enabled
$networkCategory = 'Unknown'${addressLookup}
[pscustomobject]@{
  ruleAllowed = $ruleAllowed
  privateFirewallEnabled = $privateFirewallEnabled
  networkCategory = $networkCategory
} | ConvertTo-Json -Compress`
}

function buildRepairScript(port: number, executablePath: string): string {
  return `$ErrorActionPreference = 'Stop'
Get-NetFirewallRule -Name ${quotePowerShell(FIREWALL_RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name ${quotePowerShell(FIREWALL_RULE_NAME)} -DisplayName ${quotePowerShell(FIREWALL_RULE_DISPLAY_NAME)} -Description 'Allows Orca Mobile to connect to this Orca desktop on private networks.' -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP -LocalPort ${port} -Program ${quotePowerShell(executablePath)} -EdgeTraversalPolicy Block | Out-Null`
}

function buildElevationScript(powershellPath: string, encodedRepairScript: string): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath ${quotePowerShell(powershellPath)} -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encodedRepairScript}') -Verb RunAs -Wait -PassThru
  [pscustomobject]@{ launched = $true; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ launched = $false; nativeErrorCode = $_.Exception.NativeErrorCode } | ConvertTo-Json -Compress
}`
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function getWindowsPowerShellPath(systemRoot = 'C:\\Windows'): string {
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function getRunner(environment: WindowsMobileFirewallEnvironment): PowerShellRunner {
  return environment.runPowerShell ?? createPowerShellRunner(environment.systemRoot)
}

function createPowerShellRunner(systemRoot?: string): PowerShellRunner {
  const powershellPath = getWindowsPowerShellPath(systemRoot)
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }
          resolve(stdout)
        }
      )
    })
}
