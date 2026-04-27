import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { fork } from 'child_process'
import { connect } from 'net'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  type DaemonLauncher
} from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonClient } from './client'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type ListSessionsResult
} from './types'
import { healthCheckDaemon, killStaleDaemon } from './daemon-health'
import { setLocalPtyProvider } from '../ipc/pty'

let spawner: DaemonSpawner | null = null
let adapter: DaemonPtyRouter | DaemonPtyAdapter | null = null

function getRuntimeDir(): string {
  const dir = join(app.getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getHistoryDir(): string {
  const dir = join(app.getPath('userData'), 'terminal-history')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getDaemonEntryPath(): string {
  const appPath = app.getAppPath()
  // Why: electron-builder unpacks daemon-entry.js so child_process.fork() can
  // execute it from disk. In packaged apps app.getAppPath() points at
  // app.asar, so redirect to the unpacked sibling before joining the script.
  const basePath = app.isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return join(basePath, 'out', 'main', 'daemon-entry.js')
}

// Why: before spawning a new daemon, check if an existing one is alive by
// attempting a TCP connection to the socket. If it connects, the daemon
// survived from a previous app session — reuse it instead of spawning.
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, 1000)
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function createOutOfProcessLauncher(runtimeDir: string): DaemonLauncher {
  return async (socketPath, tokenPath) => {
    const healthy = await healthCheckDaemon(socketPath, tokenPath)
    if (healthy) {
      // Why: daemon is already running from a previous app session and
      // responded to a protocol-level ping. Safe to reuse.
      return {
        shutdown: async () => {
          await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
        }
      }
    }

    // Why: a raw socket can outlive a broken or wedged daemon. Kill by PID
    // before respawn so the new daemon does not race the stale process.
    await killStaleDaemon(runtimeDir, socketPath, tokenPath)

    const entryPath = getDaemonEntryPath()
    const userDataPath = app.getPath('userData')
    const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
      // Why: detached + unref lets the daemon outlive the Electron process.
      // stdio 'ignore' prevents the child from holding the parent's stdout
      // open, which would prevent Electron from exiting cleanly.
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Why: ELECTRON_RUN_AS_NODE makes the forked process run as a plain
      // Node.js process instead of an Electron renderer/main process. Without
      // it, Electron's GPU/display initialization can interfere with native
      // module operations like node-pty's posix_spawn of the spawn-helper.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // Why: the detached daemon is plain Node and cannot call Electron's
        // app.getPath(), but shell-ready rcfiles must live outside swept tmp.
        ORCA_USER_DATA_PATH: userDataPath
      }
    })

    // Wait for the daemon to signal readiness via IPC
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        clearTimeout(timer)
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(new Error('Daemon startup timed out'))
      }, 10000)

      child.on('message', (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
          clearTimeout(timer)
          if (child.pid) {
            writeFileSync(getDaemonPidPath(runtimeDir), String(child.pid), { mode: 0o600 })
          }
          // Why: disconnect IPC channel and unref so Electron can exit
          // without waiting for the daemon. The daemon keeps running.
          child.disconnect()
          child.unref()
          resolve()
        }
      })

      child.on('error', (err) => {
        fail(err)
      })

      child.on('exit', (code) => {
        fail(new Error(`Daemon exited during startup with code ${code}`))
      })
    })

    return {
      shutdown: async () => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
      }
    }
  }
}

export async function initDaemonPtyProvider(): Promise<void> {
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir)
  })

  // Why: assign spawner/adapter only after both succeed. If ensureRunning()
  // throws, a stale spawner would prevent shutdownDaemon() from cleaning up
  // correctly on retry.
  const info = await newSpawner.ensureRunning()

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir(),
    // Why: when the daemon process dies (e.g. killed by a signal, OOM, or
    // cascading from a force-quit of child processes), the adapter's
    // ensureConnected() detects the dead socket and calls this to fork a
    // replacement daemon before retrying the connection.
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
    }
  })

  const legacyAdapters = await createLegacyDaemonAdapters(runtimeDir)
  const routedAdapter =
    legacyAdapters.length > 0
      ? new DaemonPtyRouter({
          current: newAdapter,
          legacy: legacyAdapters
        })
      : newAdapter
  if (routedAdapter instanceof DaemonPtyRouter) {
    await routedAdapter.discoverLegacySessions()
  }

  spawner = newSpawner
  adapter = routedAdapter
  setLocalPtyProvider(routedAdapter)
}

// Why: disconnect from the daemon without killing it. The daemon runs as a
// separate process and survives app quit — sessions stay alive for warm
// reattach on next launch. Leave history sessions marked "unclean" here so a
// later daemon crash while Orca is closed is still recoverable on next launch.
export function disconnectDaemon(): void {
  adapter?.disconnectOnly()
  adapter = null
}

/** Kill the daemon and all its sessions. Use for full cleanup only. */
export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  await spawner?.shutdown()
  spawner = null
  try {
    unlinkSync(getDaemonPidPath(getRuntimeDir()))
  } catch {
    // Best-effort
  }
}

export type OrphanedDaemonCleanupResult = {
  /** True when we detected a live daemon socket and connected to tear it down.
   *  False when no daemon was running (fresh install or clean previous quit). */
  cleaned: boolean
  /** Number of live PTY sessions killed during cleanup. The caller surfaces this
   *  to the user so they know what background work was stopped. */
  killedCount: number
}

async function cleanupDaemonForProtocol(
  runtimeDir: string,
  protocolVersion: number
): Promise<OrphanedDaemonCleanupResult> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)

  const alive = await probeSocket(socketPath)
  if (!alive) {
    // Why: still best-effort remove a stale socket file so a future opt-in
    // launch doesn't hit EADDRINUSE when the daemon tries to bind.
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort
      }
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // Best-effort
    }
    return { cleaned: false, killedCount: 0 }
  }

  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  let killedCount = 0
  let didRequestShutdown = false
  let didKillStaleDaemon = false
  try {
    await client.ensureConnected()
    const sessions = await client
      .request<ListSessionsResult>('listSessions', undefined)
      .catch(() => ({ sessions: [] }))
    killedCount = sessions.sessions.filter((s) => s.isAlive).length

    // Why: the daemon exposes a single-shot `shutdown` RPC (daemon-server.ts)
    // that kills every session and then terminates its own process. Using it
    // avoids the race between per-session `kill` calls and the daemon exiting.
    await client.request('shutdown', { killSessions: true }).catch(() => {
      // Daemon exits immediately after handling the RPC — the socket may close
      // before the reply round-trips. Treat that as success.
    })
    didRequestShutdown = true
  } catch {
    // Why: previous-protocol daemons may be wedged or too old to complete the
    // RPC cleanup path. Fall back to PID cleanup, but daemon-health only
    // unlinks a live socket after proving it killed the matching process.
    didKillStaleDaemon = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
  } finally {
    client.disconnect()
  }

  // Why: after `shutdown`, the daemon unlinks its socket itself — but on some
  // crash paths the file lingers. Clean up defensively so a later opt-in
  // relaunch can bind cleanly.
  if (didRequestShutdown && process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Best-effort
    }
  }
  try {
    unlinkSync(pidPath)
  } catch {
    // Best-effort
  }

  return { cleaned: didRequestShutdown || didKillStaleDaemon, killedCount }
}

async function createLegacyDaemonAdapters(runtimeDir: string): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      continue
    }
    // Why: old daemon PTYs can be running long-lived agents during an app
    // upgrade. Keep those sessions routed to their original daemon while new
    // terminals use the current protocol, instead of killing background work.
    // Legacy adapters intentionally do not respawn: respawning an old protocol
    // daemon from new code would recreate stale env semantics and can be less
    // predictable than letting the session fail if that old daemon dies.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion,
        historyPath: getHistoryDir()
      })
    )
  }
  return adapters
}

/** Detect and tear down an orphaned daemon left behind by a previous app
 *  session (e.g. a user who had `experimentalTerminalDaemon` enabled on an
 *  older build and is now launching a build where the feature is disabled).
 *
 *  Why it matters: the daemon is designed to outlive the Electron process.
 *  If we just skip `initDaemonPtyProvider()` on this launch, any live sessions
 *  from the previous session keep running invisibly — consuming CPU / holding
 *  files open / re-launching on every boot because nothing ever kills them.
 *  This helper connects to the existing socket, enumerates sessions, and asks
 *  the daemon to shut itself down (which terminates all PTYs). */
export async function cleanupOrphanedDaemon(): Promise<OrphanedDaemonCleanupResult> {
  const runtimeDir = getRuntimeDir()
  let cleaned = false
  let killedCount = 0

  for (const protocolVersion of [PROTOCOL_VERSION, ...PREVIOUS_DAEMON_PROTOCOL_VERSIONS]) {
    const result = await cleanupDaemonForProtocol(runtimeDir, protocolVersion)
    cleaned ||= result.cleaned
    killedCount += result.killedCount
  }

  return { cleaned, killedCount }
}
