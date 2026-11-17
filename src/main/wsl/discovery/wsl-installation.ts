import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  _resetWslNotInstalledLatchForTests,
  latchWslNotInstalled
} from '@orca/process-host/wsl-not-installed-latch'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { resolveWslInteropSpawnCwd } from '../execution/wsl-interop-spawn-directory'

// Why: Windows 11 24H2's inbox wsl.exe launches the installer on any invocation.
// WSLService (Store/MSI) or LxssManager (inbox optional component) means WSL is installed.
// CurrentVersion\Lxss can exist when WSL is not installed, so it is not the signal.
const WSL_SERVICE_NAMES = ['WSLService', 'LxssManager'] as const
const SERVICE_QUERY_TIMEOUT_MS = 5_000
// sc.exe exits with the Win32 error; only this one proves the service is not registered.
const ERROR_SERVICE_DOES_NOT_EXIST = 1060
// Hardened hosts deny sc.exe on every call; don't re-spawn it on each running-list read.
const UNKNOWN_INSTALLATION_TTL_MS = 60_000

export type WslInstallation = 'present' | 'absent' | 'unknown'

let serviceBinaryOnDisk: boolean | undefined

/**
 * Sync, spawn-free hint for readers that run before the service verdict: the inbox component's
 * LxssManager.dll or the Store/MSI install's wslservice.exe. System32\wsl.exe is the stub, so it doesn't count.
 * Checked once per process; the service verdict supersedes it.
 */
export function wslServiceBinaryOnDisk(): boolean {
  if (serviceBinaryOnDisk === undefined) {
    const env = process.env
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
    const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? 'C:\\Program Files'
    serviceBinaryOnDisk = [
      pathWin32.join(systemRoot, 'System32', 'lxss', 'LxssManager.dll'),
      pathWin32.join(programFiles, 'WSL', 'wslservice.exe')
    ].some((path) => existsSync(path))
  }
  return serviceBinaryOnDisk
}

let installation: WslInstallation | null = null
let installationProbe: Promise<WslInstallation> | null = null
let unknownUntilMs = 0

function serviceQuerySpec(name: string): ProcessSpec {
  return {
    program: windowsSystem32Binary('sc.exe'),
    args: ['query', name],
    timeoutMs: SERVICE_QUERY_TIMEOUT_MS,
    cwd: resolveWslInteropSpawnCwd()
  }
}

function classifyServiceQuery(result: ProcessResult): WslInstallation {
  // sc query exits 0 when the service is registered, including while it is stopped.
  if (result.code === 0) {
    return 'present'
  }
  // Access denied, a timeout or a signal kill says nothing about the install.
  return result.code === ERROR_SERVICE_DOES_NOT_EXIST ? 'absent' : 'unknown'
}

function combineServiceQueries(results: readonly WslInstallation[]): WslInstallation {
  if (results.includes('present')) {
    return 'present'
  }
  if (results.length > 0 && results.every((result) => result === 'absent')) {
    return 'absent'
  }
  return 'unknown'
}

function rememberInstallation(found: WslInstallation): WslInstallation {
  // An unknown sc.exe failure must stay retryable and must not hide a real WSL install.
  if (found !== 'unknown') {
    installation = found
  } else {
    unknownUntilMs = Date.now() + UNKNOWN_INSTALLATION_TTL_MS
  }
  // Confirmed absence lasts for the session: installing WSL while Orca runs needs a restart.
  if (found === 'absent') {
    latchWslNotInstalled()
  }
  return found
}

async function queryServices(): Promise<WslInstallation> {
  const results: WslInstallation[] = []
  for (const name of WSL_SERVICE_NAMES) {
    try {
      results.push(classifyServiceQuery(await runProcess(serviceQuerySpec(name))))
    } catch {
      results.push('unknown')
      break
    }
    if (results.at(-1) === 'present') {
      break
    }
  }
  return rememberInstallation(combineServiceQueries(results))
}

function cachedInstallation(): WslInstallation | null {
  if (installation) {
    return installation
  }
  return Date.now() < unknownUntilMs ? 'unknown' : null
}

/** Cached answer only; sync readers must not spawn. Null means no service query has finished. */
export function peekWslInstallation(): WslInstallation | null {
  if (process.platform !== 'win32') {
    return 'absent'
  }
  const cached = cachedInstallation()
  if (cached || unknownUntilMs === 0) {
    return cached
  }
  // Serve the expired unknown while a re-check runs, so sync readers never fall back to "no verdict".
  void readWslInstallation()
  return 'unknown'
}

/** Shared probe. Absent is cached for the process lifetime; unknown only briefly. */
export function readWslInstallation(): Promise<WslInstallation> {
  if (process.platform !== 'win32') {
    return Promise.resolve('absent')
  }
  const cached = cachedInstallation()
  if (cached) {
    return Promise.resolve(cached)
  }
  if (installationProbe) {
    return installationProbe
  }
  const probe = queryServices().finally(() => {
    if (installationProbe === probe) {
      installationProbe = null
    }
  })
  installationProbe = probe
  return probe
}

export function _resetWslInstallationForTests(): void {
  serviceBinaryOnDisk = undefined
  installation = null
  installationProbe = null
  unknownUntilMs = 0
  _resetWslNotInstalledLatchForTests()
}

export function _setWslInstallationForTests(value: WslInstallation | null): void {
  installation = value
  installationProbe = null
  unknownUntilMs = 0
  _resetWslNotInstalledLatchForTests()
  if (value === 'absent') {
    latchWslNotInstalled()
  }
}
