import { runProcess } from '@orca/process-host'
import { latchWslNotInstalled } from '@orca/process-host/wsl-not-installed-latch'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { resolveWslInteropSpawnCwd } from '../execution/wsl-interop-spawn-directory'
import { loadWindowsNativeRegistry } from '../../windows/windows-native-registry'

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

// Registered services live here; the addon reads the key in-process, with no spawn.
const SERVICES_KEY = 'SYSTEM\\CurrentControlSet\\Services\\'

let serviceRegistered: boolean | undefined

/**
 * Sync and spawn-free: whether either WSL service key exists. A key proves registration, but a
 * missing one may be an unreadable key, so absence still needs sc.exe's 1060. Read once per process.
 */
function wslServiceKeyRegistered(): boolean {
  if (serviceRegistered === undefined) {
    try {
      const registry = loadWindowsNativeRegistry()
      serviceRegistered = WSL_SERVICE_NAMES.some(
        (name) => registry.getRegistryKey(registry.HK.LM, SERVICES_KEY + name) != null
      )
    } catch {
      serviceRegistered = false
    }
  }
  return serviceRegistered
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
  if (wslServiceKeyRegistered()) {
    installation = 'present'
    return installation
  }
  return Date.now() < unknownUntilMs ? 'unknown' : null
}

/**
 * Cached answer only; never spawns. Null means no verdict yet. An expired unknown is still served
 * as unknown; sync readers use peekWslInstallationAndRefreshIfDue() to start the re-check.
 */
export function peekWslInstallation(): WslInstallation | null {
  if (process.platform !== 'win32') {
    return 'absent'
  }
  return cachedInstallation() ?? (unknownUntilMs > 0 ? 'unknown' : null)
}

/** For sync readers: the cached answer, starting the async service query when none is current. */
export function peekWslInstallationAndRefreshIfDue(): WslInstallation | null {
  const cached = peekWslInstallation()
  if (process.platform === 'win32' && cachedInstallation() === null) {
    void readWslInstallation()
  }
  return cached
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
