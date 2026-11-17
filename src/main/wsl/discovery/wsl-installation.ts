import { runProcess, runProcessSync } from '@orca/process-host'
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

export type WslInstallation = 'present' | 'absent' | 'unknown'

let installation: WslInstallation | null = null
let installationProbe: Promise<WslInstallation> | null = null

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
  }
  if (found === 'absent') {
    latchWslNotInstalled()
  }
  return found
}

function queryServicesSync(): WslInstallation {
  const results: WslInstallation[] = []
  for (const name of WSL_SERVICE_NAMES) {
    try {
      results.push(classifyServiceQuery(runProcessSync(serviceQuerySpec(name))))
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

/** Cached answer only. Null means the service query has not finished. */
export function peekWslInstallation(): WslInstallation | null {
  if (process.platform !== 'win32') {
    return 'absent'
  }
  return installation
}

/** Synchronous read for listWslDistros. Absent is cached for the process lifetime. */
export function readWslInstallationSync(): WslInstallation {
  if (process.platform !== 'win32') {
    return 'absent'
  }
  if (installation) {
    return installation
  }
  return queryServicesSync()
}

/** Shared probe. Absent is cached for the process lifetime; unknown is not. */
export function readWslInstallation(): Promise<WslInstallation> {
  if (process.platform !== 'win32') {
    return Promise.resolve('absent')
  }
  if (installation) {
    return Promise.resolve(installation)
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
  installation = null
  installationProbe = null
  _resetWslNotInstalledLatchForTests()
}

export function _setWslInstallationForTests(value: WslInstallation | null): void {
  installation = value
  installationProbe = null
  _resetWslNotInstalledLatchForTests()
  if (value === 'absent') {
    latchWslNotInstalled()
  }
}
