import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, existsSync, unlinkSync } from 'fs'
import { fork } from 'child_process'
import { connect } from 'net'
import { DaemonSpawner, type DaemonLauncher } from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { setLocalPtyProvider } from '../ipc/pty'

let spawner: DaemonSpawner | null = null
let adapter: DaemonPtyAdapter | null = null

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

function createOutOfProcessLauncher(): DaemonLauncher {
  return async (socketPath, tokenPath) => {
    const alive = await probeSocket(socketPath)
    if (alive) {
      // Why: daemon is already running from a previous app session.
      // No new process to manage — return a no-op shutdown handle.
      return { shutdown: async () => {} }
    }

    // Why: stale socket file from a crashed daemon blocks the new server
    // from binding. Remove it before spawning.
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      unlinkSync(socketPath)
    }

    const entryPath = getDaemonEntryPath()
    const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
      // Why: detached + unref lets the daemon outlive the Electron process.
      // stdio 'ignore' prevents the child from holding the parent's stdout
      // open, which would prevent Electron from exiting cleanly.
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
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
    launcher: createOutOfProcessLauncher()
  })

  // Why: assign spawner/adapter only after both succeed. If ensureRunning()
  // throws, a stale spawner would prevent shutdownDaemon() from cleaning up
  // correctly on retry.
  const info = await newSpawner.ensureRunning()

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir()
  })

  spawner = newSpawner
  adapter = newAdapter
  setLocalPtyProvider(adapter)
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
}
