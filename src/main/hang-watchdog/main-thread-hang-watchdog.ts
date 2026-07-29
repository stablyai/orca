import { fork, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { resolveHangWatchdogEntryPath } from './hang-watchdog-entry-path'
import { hangDetectionMarkerPath } from './hang-detection-marker'

const HEARTBEAT_INTERVAL_MS = 2_000

export type MainThreadHangWatchdogHandle = {
  stop: () => void
  child: ChildProcess
}

// Why: macOS 26 scene-backed AppKit windows can deadlock the main thread inside
// FrontBoardServices with no crash and no event loop left to self-report. A plain-Node sibling
// process watches heartbeats and records the stall so the next launch can report it. It observes
// only — see main-thread-hang-watchdog-entry.ts for why it does not kill the parent.
export function installMainThreadHangWatchdog(options: {
  userDataPath: string
}): MainThreadHangWatchdogHandle | null {
  if (process.platform !== 'darwin') {
    return null
  }
  // Why: dev main threads pause in debuggers routinely; watch packaged builds only unless forced.
  if (!app.isPackaged && process.env.ORCA_HANG_WATCHDOG_FORCE !== '1') {
    return null
  }
  const entryPath = resolveHangWatchdogEntryPath(app.getAppPath(), app.isPackaged)
  let child: ChildProcess
  try {
    child = fork(entryPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_HANG_WATCHDOG_PARENT_PID: String(process.pid),
        ORCA_HANG_WATCHDOG_MARKER_PATH: hangDetectionMarkerPath(options.userDataPath)
      }
    })
  } catch (error) {
    console.error('[hang-watchdog] failed to fork watchdog process:', error)
    return null
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error('[hang-watchdog]', String(chunk).trimEnd())
  })
  // Why: the watchdog is a safety net — if it dies, run without it; a restart loop here must never affect the app.
  child.on('error', () => {})
  const heartbeatTimer = setInterval(() => {
    if (child.connected) {
      try {
        child.send({ type: 'heartbeat' }, () => {})
      } catch {
        // Channel raced closed between the check and the send.
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
  let stopped = false
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(heartbeatTimer)
    if (child.connected) {
      try {
        child.send({ type: 'shutdown' }, () => {})
      } catch {
        // Already disconnecting.
      }
    }
    // Why: disconnect guarantees the child observes parent shutdown and exits instead of misreading quit as a hang.
    try {
      child.disconnect()
    } catch {
      // Channel already closed.
    }
  }
  // Why: will-quit fires twice during quit; stop is idempotent.
  app.on('will-quit', stop)
  return { stop, child }
}
