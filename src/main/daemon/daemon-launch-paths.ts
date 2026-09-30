import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { scheduleTerminalHistoryPermissionRepair } from './terminal-history-permission-repair'
import { getDaemonLogFilePath } from '../observability/logs-directory'
import { DaemonClient } from './client'
import { daemonRecoveryProbeTimeoutMs } from './daemon-recovery-budget'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

export function getDaemonRuntimeDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'daemon')
  ensurePrivateDir(dir)
  return dir
}

export function getDaemonHistoryDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'terminal-history')
  ensurePrivateDir(dir)
  // Why here: the one accessor every history producer goes through, so the backlog sweep is hooked
  // once per host that owns the files — native, WSL, or a remote SSH server's own main process.
  // The scheduler defers and de-duplicates, so the several startup calls cost one late sweep.
  void scheduleTerminalHistoryPermissionRepair(dir)
  return dir
}

export function getDaemonEntryPath(): string {
  const appPath = getAppEnvironment().getAppPath()
  // Why: packaged getAppPath() points at app.asar, so redirect to app.asar.unpacked where daemon-entry.js is fork-executable.
  // Why asar and not isPackaged: orcad is a packaged non-Electron host whose bundle root holds
  // orcad.js and daemon-entry.js side by side with no asar to redirect (see parcel-watcher-entry-path.ts).
  const basePath = appPath.includes('app.asar')
    ? appPath.replace('app.asar', 'app.asar.unpacked')
    : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  return existsSync(directEntryPath)
    ? directEntryPath
    : join(basePath, 'out', 'main', 'daemon-entry.js')
}

// macOS TCC attribution pins the daemon to a packaged app bundle; there is none on a Node host.
export function resolvePackagedDarwinAppVersion(): string | null {
  const environment = getAppEnvironment()
  return process.platform === 'darwin' && environment.isPackaged() ? environment.getVersion() : null
}

// Why: pass a log-file arg so field failures are diagnosable, but honor the ORCA_DIAGNOSTICS_DISABLED privacy switch.
export function daemonLogArgs(): string[] {
  const disabled = (process.env.ORCA_DIAGNOSTICS_DISABLED ?? '').trim().toLowerCase()
  return disabled === '1' || disabled === 'true' ? [] : ['--log-file', getDaemonLogFilePath()]
}

// Why recoveryDeadlineMs is required: this probe only ever runs on a startup path that has a
// budget, and the client's own defaults are far larger than any of them.
export async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  recoveryDeadlineMs: number,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  // Why one slice for both: a wedged handshake must not leave the request its own fresh 30s.
  const probeTimeoutMs = daemonRecoveryProbeTimeoutMs(recoveryDeadlineMs)
  const probeDeadlineMs = Date.now() + probeTimeoutMs
  try {
    await client.ensureConnectedWithin(probeTimeoutMs)
    const result = await client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      remainingDaemonRequestTimeoutMs(probeDeadlineMs)
    )
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}
