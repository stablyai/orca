import { execFile } from 'node:child_process'
import { release as getOsRelease } from 'node:os'
import { win32 as pathWin32 } from 'node:path'
import { parseDn } from 'builder-util-runtime'

export const EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT =
  // Why: the SignPath publisher subject is shared; pin the observed Orca release
  // signing certificate so a valid unrelated SignPath project is not enough.
  'F7394FAE852E68922222C04A4364204298E6E82E'

const POWERSHELL_PREFLIGHT_TIMEOUT_MS = 10_000
const POWERSHELL_SIGNATURE_TIMEOUT_MS = 20_000
const DEFAULT_WINDOWS_DIRECTORY = 'C:\\Windows'

type AuthenticodeSignatureSummary = {
  Status?: unknown
  Path?: unknown
  SignerCertificate?: {
    Subject?: unknown
    Thumbprint?: unknown
  } | null
}

export async function runWindowsSignatureCapabilityPreflight(): Promise<string | null> {
  const osRelease = getOsRelease()
  if (osRelease.startsWith('6.') && !osRelease.startsWith('6.3')) {
    return `Windows ${osRelease} cannot run the update signature verifier safely.`
  }

  return (
    (await runPowerShellCapabilityCommand('PowerShell', '$PSVersionTable.PSVersion | Out-Null')) ??
    (await runPowerShellCapabilityCommand(
      'Get-AuthenticodeSignature',
      'Get-Command Get-AuthenticodeSignature -ErrorAction Stop | Out-Null'
    )) ??
    (await runPowerShellCapabilityCommand('ConvertTo-Json', 'ConvertTo-Json test | Out-Null'))
  )
}

export async function verifyWindowsUpdaterAuthenticodeSignature(
  installerPath: string,
  publisherNames: readonly string[]
): Promise<string | null> {
  let signatureSummary: AuthenticodeSignatureSummary
  try {
    const stdout = await execPowerShell(
      createAuthenticodeSignatureSummaryCommand(installerPath),
      POWERSHELL_SIGNATURE_TIMEOUT_MS,
      'Windows update signer thumbprint check timed out.'
    )
    signatureSummary = JSON.parse(stdout) as AuthenticodeSignatureSummary
  } catch (error) {
    return `Windows update Authenticode check failed: ${readErrorMessage(error)}`
  }

  if (!isValidAuthenticodeStatus(signatureSummary.Status)) {
    return 'Windows update installer signature is not valid.'
  }

  if (!isRequestedInstallerPath(signatureSummary.Path, installerPath)) {
    return 'Windows update installer literal path did not match the requested path.'
  }

  if (!isExpectedPublisher(signatureSummary.SignerCertificate?.Subject, publisherNames)) {
    return 'Windows update installer publisher is not trusted.'
  }

  const thumbprint = normalizeThumbprint(signatureSummary.SignerCertificate?.Thumbprint)
  if (thumbprint !== EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT) {
    return 'Windows update installer signer thumbprint is not trusted.'
  }

  return null
}

async function runPowerShellCapabilityCommand(
  capability: string,
  command: string
): Promise<string | null> {
  try {
    await execPowerShell(
      command,
      POWERSHELL_PREFLIGHT_TIMEOUT_MS,
      `Windows update signature verifier preflight timed out while checking ${capability}.`
    )
    return null
  } catch (error) {
    return `Windows update signature verifier is unavailable: ${capability} could not run. ${readErrorMessage(error)}`
  }
}

function createAuthenticodeSignatureSummaryCommand(installerPath: string): string {
  const escapedInstallerPath = escapePowerShellSingleQuotedString(installerPath)
  return (
    `Get-AuthenticodeSignature -LiteralPath '${escapedInstallerPath}' | ` +
    'Select-Object -Property Status,Path,SignerCertificate | ConvertTo-Json -Compress'
  )
}

function execPowerShell(
  command: string,
  timeoutMs: number,
  timeoutMessage: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let childProcess: ReturnType<typeof execFile> | undefined
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      childProcess?.kill()
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    childProcess = execFile(
      getSystemPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command],
      { env: getPowerShellEnvironment(), timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (error) {
          reject(error)
          return
        }
        if (stderr) {
          reject(new Error(stderr))
          return
        }
        resolve(stdout)
      }
    )
  })
}

function getSystemPowerShellPath(): string {
  return pathWin32.join(
    getWindowsDirectory(),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function getPowerShellEnvironment(): NodeJS.ProcessEnv {
  const windowsDirectory = getWindowsDirectory()
  return {
    // Why: prevent user-writable PowerShell modules from shadowing built-in
    // Authenticode commands while still letting system modules load.
    PSModulePath: pathWin32.join(
      windowsDirectory,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules'
    ),
    ProgramData: process.env.ProgramData,
    SystemRoot: windowsDirectory,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    windir: windowsDirectory
  }
}

function getWindowsDirectory(): string {
  return process.env.SystemRoot || process.env.windir || DEFAULT_WINDOWS_DIRECTORY
}

function isValidAuthenticodeStatus(status: unknown): boolean {
  return status === 0 || status === 'Valid'
}

function isRequestedInstallerPath(value: unknown, installerPath: string): boolean {
  return (
    typeof value === 'string' && pathWin32.normalize(value) === pathWin32.normalize(installerPath)
  )
}

function isExpectedPublisher(value: unknown, publisherNames: readonly string[]): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const subject = parseDn(value)
  for (const name of publisherNames) {
    const expectedDn = parseDn(name)
    if (expectedDn.size > 0) {
      const expectedKeys = Array.from(expectedDn.keys())
      if (expectedKeys.every((key) => expectedDn.get(key) === subject.get(key))) {
        return true
      }
      continue
    }
    if (name === subject.get('CN')) {
      return true
    }
  }
  return false
}

function normalizeThumbprint(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/\s/gu, '').toUpperCase() : null
}

function escapePowerShellSingleQuotedString(value: string): string {
  // Why: mirror electron-updater's LiteralPath escaping before handing paths to PowerShell.
  return value.replace(/'/gu, "''")
}

function readErrorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error)
}
