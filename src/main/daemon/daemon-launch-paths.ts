import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { scheduleTerminalHistoryPermissionRepair } from './terminal-history-permission-repair'
import { getDaemonLogFilePath } from '../observability/logs-directory'
import { daemonRuntimeDirFor } from './daemon-runtime-dir'
import { DaemonClient } from './client'
import { daemonRecoveryProbeTimeoutMs } from './daemon-recovery-budget'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

export function getDaemonRuntimeDir(): string {
  const dir = daemonRuntimeDirFor(getAppEnvironment().getPath('userData'))
  ensurePrivateDir(dir)
  return dir
}

export function getDaemonHistoryDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'terminal-history')
  ensurePrivateDir(dir)
  // Schedule one deferred permission sweep per host, including WSL and SSH servers.
  void scheduleTerminalHistoryPermissionRepair(dir)
  return dir
}

export function getDaemonEntryPath(): string {
  const appPath = getAppEnvironment().getAppPath()
  // Electron needs the unpacked script; packaged orcad has no asar to redirect.
  const basePath = appPath.includes('app.asar')
    ? appPath.replace('app.asar', 'app.asar.unpacked')
    : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  return existsSync(directEntryPath)
    ? directEntryPath
    : join(basePath, 'out', 'main', 'daemon-entry.js')
}

/** Recycle drained stale daemons on macOS for TCC; orcad opts in everywhere for code and umask updates. */
export function resolveStaleDaemonRecycleVersion(onEveryPlatform = false): string | null {
  const environment = getAppEnvironment()
  if (!environment.isPackaged()) {
    return null
  }
  return onEveryPlatform || process.platform === 'darwin' ? environment.getVersion() : null
}

export function daemonLogArgs(): string[] {
  const disabled = (process.env.ORCA_DIAGNOSTICS_DISABLED ?? '').trim().toLowerCase()
  return disabled === '1' || disabled === 'true' ? [] : ['--log-file', getDaemonLogFilePath()]
}

// Keep deadline clamps aligned with the default probe budget.
export const DAEMON_SOCKET_PROBE_TIMEOUT_MS = 1_000

// A connection proves reachability; authentication and health need separate checks.
export function probeDaemonSocket(
  socketPath: string,
  timeoutMs = DAEMON_SOCKET_PROBE_TIMEOUT_MS
): Promise<boolean> {
  let resolve!: (alive: boolean) => void
  const promise = new Promise<boolean>((settle) => {
    resolve = settle
  })
  if (process.platform !== 'win32' && !existsSync(socketPath)) {
    resolve(false)
    return promise
  }
  const socket = connect({ path: socketPath })
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (alive: boolean, destroy = false): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    socket.removeListener('connect', onConnect)
    socket.removeListener('error', onError)
    if (destroy) {
      socket.destroy()
    }
    resolve(alive)
  }
  const onConnect = (): void => finish(true, true)
  const onError = (): void => finish(false)
  timer = setTimeout(() => finish(false, true), timeoutMs)
  socket.on('connect', onConnect)
  socket.on('error', onError)
  return promise
}

// Require the startup deadline: client defaults exceed the recovery budget.
export async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  recoveryDeadlineMs: number,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  // Share one budget so a wedged handshake cannot leave the request a fresh 30 seconds.
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
