import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { app } from 'electron'

// Why: headless `orca serve` backs browser panes with offscreen BrowserWindows.
// On Linux, Electron has no display platform without an X server and segfaults
// when such a window loads a page (verified: --headless/--ozone-platform=headless
// also crash; only a virtual display works). So before app.whenReady, ensure a
// virtual X display via Xvfb when none is present. macOS/Windows need nothing.

const XVFB_STARTUP_TIMEOUT_MS = 5_000
const XVFB_POLL_INTERVAL_MS = 50
const VIRTUAL_DISPLAY_NUMBER = 99
const VIRTUAL_DISPLAY = `:${VIRTUAL_DISPLAY_NUMBER}`

let xvfbProcess: ChildProcess | null = null

function xvfbSocketPath(displayNumber: number): string {
  return `/tmp/.X11-unix/X${displayNumber}`
}

function xDisplayLockPath(displayNumber: number): string {
  return `/tmp/.X${displayNumber}-lock`
}

// Why: a socket file can outlive the X server that made it. The X lock file holds
// the server PID; if that process is gone, the display is dead despite the socket.
function isDisplayServerAlive(displayNumber: number): boolean {
  const lockPath = xDisplayLockPath(displayNumber)
  if (!existsSync(lockPath)) {
    // No lock means no server claimed this display; the bare socket is stale.
    return false
  }
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    // signal 0 probes existence without affecting the process.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeStaleDisplayArtifacts(displayNumber: number): void {
  for (const path of [xDisplayLockPath(displayNumber), xvfbSocketPath(displayNumber)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort; if removal fails, Xvfb startup below will surface the error.
    }
  }
}

function hasXvfbBinary(): boolean {
  // Why: spawnSync `which` is cheap and avoids spawning Xvfb only to fail; a
  // clear up-front warning beats a cryptic ENOENT mid-startup.
  const result = spawnSync('which', ['Xvfb'], { stdio: 'ignore' })
  return result.status === 0
}

function sleepSync(ms: number): void {
  // Why: this runs in the synchronous pre-whenReady startup path, so block
  // without spinning the CPU or spawning a process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForDisplaySocket(displayNumber: number, deadline: number): boolean {
  const socket = xvfbSocketPath(displayNumber)
  // Why: Xvfb creates its socket asynchronously after spawn; Electron must not
  // boot before it exists or display init still fails.
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      return true
    }
    sleepSync(XVFB_POLL_INTERVAL_MS)
  }
  return existsSync(socket)
}

/**
 * Ensure a usable X display for headless Linux serve. Returns true when a
 * display is available (pre-existing or freshly started), false when browser
 * panes cannot be supported on this host. Safe to call on any platform.
 */
export function ensureVirtualDisplayForHeadlessServe(options: { isServeMode: boolean }): boolean {
  if (!options.isServeMode || process.platform !== 'linux') {
    return process.platform !== 'linux'
  }

  // Why: respect an externally provided display (a real X server, or the image
  // already running its own Xvfb). Don't start a competing one.
  if (process.env.DISPLAY && process.env.DISPLAY.trim().length > 0) {
    return true
  }

  if (!hasXvfbBinary()) {
    console.warn(
      '[serve] Xvfb not found; browser panes are unavailable on this headless Linux host. ' +
        'Install Xvfb (e.g. `apt-get install xvfb`) or set DISPLAY to enable them.'
    )
    return false
  }

  // Why: reuse an existing display ONLY if a live X server actually backs it.
  // A crashed prior run can leave an orphan socket; trusting it by path alone
  // would advertise browser support that then fails at tab creation.
  if (existsSync(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER))) {
    if (isDisplayServerAlive(VIRTUAL_DISPLAY_NUMBER)) {
      process.env.DISPLAY = VIRTUAL_DISPLAY
      return true
    }
    // Why: stale socket/lock — clean them up so Xvfb can rebind the display
    // below instead of refusing to start on an "in use" number.
    removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
  }

  try {
    xvfbProcess = spawn(
      'Xvfb',
      [VIRTUAL_DISPLAY, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
      {
        stdio: 'ignore',
        detached: false
      }
    )
    xvfbProcess.once('error', (error) => {
      console.warn('[serve] Xvfb failed to start:', error instanceof Error ? error.message : error)
    })
  } catch (error) {
    console.warn(
      '[serve] Could not start Xvfb:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }

  const ready = waitForDisplaySocket(VIRTUAL_DISPLAY_NUMBER, Date.now() + XVFB_STARTUP_TIMEOUT_MS)
  if (!ready) {
    console.warn('[serve] Xvfb did not become ready in time; browser panes may be unavailable.')
    stopVirtualDisplay()
    return false
  }

  process.env.DISPLAY = VIRTUAL_DISPLAY
  // Why: the offscreen browser must use software rendering; a virtual display has
  // no GPU. Must be set before app.whenReady (this runs at module load).
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')

  // Why: don't leave a stray Xvfb process behind when serve exits.
  app.once('will-quit', stopVirtualDisplay)

  return true
}

export function stopVirtualDisplay(): void {
  if (xvfbProcess && !xvfbProcess.killed) {
    try {
      xvfbProcess.kill()
    } catch {
      // already exiting
    }
  }
  xvfbProcess = null
}
