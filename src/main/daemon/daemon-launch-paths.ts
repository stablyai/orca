import { existsSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getDaemonLogFilePath } from '../observability/logs-directory'
import { DaemonClient } from './client'
import { daemonRecoveryProbeTimeoutMs } from './daemon-recovery-budget'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

export function getDaemonRuntimeDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDaemonHistoryDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'terminal-history')
  mkdirSync(dir, { recursive: true })
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

/** Named so a caller clamping this probe to a deadline cannot silently decouple from its default. */
export const DAEMON_SOCKET_PROBE_TIMEOUT_MS = 1_000

// Why: a socket that accepts a connection proves a daemon survived a previous app session and can be reused.
export function probeDaemonSocket(
  socketPath: string,
  timeoutMs = DAEMON_SOCKET_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
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
