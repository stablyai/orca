import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'

// Why: headless `orca serve` backs browser panes with offscreen BrowserWindows.
// On Linux, Electron has no display platform without an X server and segfaults
// when such a window loads a page (verified: --headless/--ozone-platform=headless
// also crash; only a virtual display works). So before app.whenReady, ensure a
// virtual X display via Xvfb when none is present. macOS/Windows need nothing.

const XVFB_STARTUP_TIMEOUT_MS = 5_000
const XVFB_POLL_INTERVAL_MS = 50
const STARTUP_LOCK_TIMEOUT_MS = XVFB_STARTUP_TIMEOUT_MS * 2
const STARTUP_LOCK_STALE_MS = 5_000
const VIRTUAL_DISPLAY_NUMBER = 99
const VIRTUAL_DISPLAY = `:${VIRTUAL_DISPLAY_NUMBER}`
const XVFB_INSTALL_GUIDANCE =
  'Install `xvfb` on Debian/Ubuntu or `xorg-x11-server-Xvfb` on RPM-based systems.'

let xvfbProcess: ChildProcess | null = null

function configureHeadlessServeChromiumFlags(): void {
  // Why: cloud sandboxes often expose a tiny /dev/shm; Chromium treats an
  // exhausted shared-memory mount as ENOSPC and can fatal in utility services
  // such as font_data. Keep browser panes on disk-backed temp storage instead.
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  // Why: externally managed displays are commonly Xvfb too; a GPU-process fork can trap before serve readiness.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

const xvfbSocketPath = (displayNumber: number): string => `/tmp/.X11-unix/X${displayNumber}`
const xDisplayLockPath = (displayNumber: number): string => `/tmp/.X${displayNumber}-lock`

// Why: a socket file can outlive the X server that made it. The X lock file holds the server PID;
// if that process is gone, the display is dead despite the socket. `missing` is a third outcome the
// two callers must treat differently — see each call site.
type DisplayLockProbe = 'alive' | 'dead' | 'missing'
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return hasErrorCode(error, 'EPERM')
  }
}

function probeDisplayLock(displayNumber: number): DisplayLockProbe {
  try {
    const pid = Number.parseInt(readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim(), 10)
    return isPidAlive(pid) ? 'alive' : 'dead'
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? 'missing' : 'dead'
  }
}

/**
 * Checks whether an X display lock file exists for a dead or corrupt process.
 * If the process holding the lock is dead (ESRCH) or the lock file is malformed,
 * the lock is stale and should be cleared before Xvfb spawn.
 *
 * @param displayNumber - The X11 display number (e.g. 99 for :99).
 * @returns True if the lock file exists for a dead or corrupt process; otherwise false.
 */
export const isStaleDisplayLock = (displayNumber: number): boolean =>
  probeDisplayLock(displayNumber) === 'dead'

/**
 * Removes stale X11 lock and socket artifacts for a given display number.
 * Re-verifies that the display server remains dead before removing files
 * to avoid clobbering an active server spawned by a concurrent launch.
 *
 * @param displayNumber - The X11 display number (e.g. 99 for :99).
 */
export function removeStaleDisplayArtifacts(displayNumber: number): void {
  if (probeDisplayLock(displayNumber) === 'alive') {
    return
  }
  for (const path of [xDisplayLockPath(displayNumber), xvfbSocketPath(displayNumber)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort; if removal fails, Xvfb startup below will surface the error.
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForDisplayReady(displayNumber: number, deadline: number): boolean {
  const isReady = (): boolean =>
    isUnixSocket(xvfbSocketPath(displayNumber)) && probeDisplayLock(displayNumber) === 'alive'
  while (Date.now() < deadline) {
    if (isReady()) {
      return true
    }
    sleepSync(XVFB_POLL_INTERVAL_MS)
  }
  return isReady()
}

/**
 * Validate display syntax and local sockets before Chromium reaches Ozone initialization.
 *
 * @param env - The process environment to check (defaults to process.env).
 * @returns True if a usable Linux display is available or if on non-Linux; otherwise false.
 */
export function hasUsableLinuxDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') {
    return true
  }

  const ozone = (
    app.commandLine.getSwitchValue('ozone-platform') ||
    env.ELECTRON_OZONE_PLATFORM_HINT ||
    ''
  )
    .trim()
    .toLowerCase()
  if (ozone === 'x11') {
    return hasUsableXDisplay(env.DISPLAY)
  }
  return ozone === 'wayland'
    ? hasUsableWaylandDisplay(env)
    : hasUsableXDisplay(env.DISPLAY) || hasUsableWaylandDisplay(env)
}

export const MISSING_LINUX_DISPLAY_MESSAGE = `Orca needs a usable display server, but the selected X11 or Wayland endpoint is unavailable.\nCheck DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and any --ozone-platform override.\nUse \`orca-ide serve\` to run headless. On a bare server, ${XVFB_INSTALL_GUIDANCE}`

function hasAbstractXSocket(displayNumber: number): boolean {
  try {
    const address = `@${xvfbSocketPath(displayNumber)}`
    return readFileSync('/proc/net/unix', 'utf8')
      .split('\n')
      .some((line) => line.slice(line.lastIndexOf(' ') + 1).trimEnd() === address)
  } catch {
    return false
  }
}

function isUnixSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

function hasUsableXDisplay(value: string | undefined): boolean {
  const display = value?.trim()
  if (!display) {
    return false
  }

  const localDisplay = /^(?:unix\/?)?:(\d+)(?:\.\d+)?$/i.exec(display)
  if (!localDisplay) {
    return /^\S+:\d+(?:\.\d+)?$/.test(display)
  }
  const displayNumber = Number(localDisplay[1])
  if (isUnixSocket(xvfbSocketPath(displayNumber))) {
    return displayNumber === VIRTUAL_DISPLAY_NUMBER
      ? probeDisplayLock(displayNumber) === 'alive'
      : probeDisplayLock(displayNumber) !== 'dead'
  }
  return hasAbstractXSocket(displayNumber)
}

function hasUsableWaylandDisplay(env: NodeJS.ProcessEnv): boolean {
  const inheritedFd = env.WAYLAND_SOCKET?.trim()
  if (inheritedFd && /^\d+$/.test(inheritedFd)) {
    return true
  }
  const display = env.WAYLAND_DISPLAY?.trim()
  if (!display) {
    return false
  }
  if (isAbsolute(display)) {
    return isUnixSocket(display)
  }

  const runtimeDir = env.XDG_RUNTIME_DIR?.trim()
  return Boolean(runtimeDir && isAbsolute(runtimeDir) && isUnixSocket(join(runtimeDir, display)))
}

/**
 * Returns the path to the startup lockfile for a virtual display.
 */
export const virtualDisplayStartupLockPath = (displayNumber: number): string =>
  `/tmp/.orca-xvfb-${displayNumber}-startup.lock`

function tryAcquireStartupLock(lockPath: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(lockPath, 'wx')
    writeSync(fd, `${process.pid}\n`)
    return true
  } catch (error) {
    if (fd !== null) {
      try {
        rmSync(lockPath, { force: true })
      } catch {}
    }
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
    throw error
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function isStaleStartupLock(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath)
    const mtime = stat.mtimeMs ?? stat.mtime?.getTime()
    if (mtime !== undefined && Date.now() - mtime > STARTUP_LOCK_STALE_MS) {
      return true
    }
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    return !isPidAlive(pid)
  } catch (error) {
    return !hasErrorCode(error, 'ENOENT')
  }
}

function acquireStartupLock(lockPath: string, deadline: number): boolean {
  do {
    if (tryAcquireStartupLock(lockPath)) {
      return true
    }
    if (isStaleStartupLock(lockPath)) {
      try {
        rmSync(lockPath, { force: true })
      } catch {}
      if (tryAcquireStartupLock(lockPath)) {
        return true
      }
    }
    if (Date.now() >= deadline) {
      break
    }
    sleepSync(XVFB_POLL_INTERVAL_MS)
  } while (Date.now() < deadline)
  return false
}

/**
 * Host-wide synchronization lock for virtual display startup.
 * Serializes startup cleanup and Xvfb spawn across concurrent processes/namespaces.
 *
 * @param displayNumber - The X11 display number (e.g. 99 for :99).
 * @param operation - Synchronous callback executing the virtual display setup.
 * @returns The result of operation, or false if the startup lock cannot be acquired.
 */
export function withVirtualDisplayStartupLock<T>(
  displayNumber: number,
  operation: () => T
): T | false {
  const lockPath = virtualDisplayStartupLockPath(displayNumber)
  if (!acquireStartupLock(lockPath, Date.now() + STARTUP_LOCK_TIMEOUT_MS)) {
    console.warn(
      `[serve] Could not acquire virtual display startup lock for :${displayNumber} within timeout; aborting virtual display startup.`
    )
    return false
  }
  try {
    return operation()
  } finally {
    try {
      rmSync(lockPath, { force: true })
    } catch {}
  }
}

/**
 * Ensure a usable X display for headless Linux serve. Returns true when a
 * display is available (pre-existing or freshly started), false when browser
 * panes cannot be supported on this host. Safe to call on any platform.
 *
 * @param options - Configuration options specifying whether serve mode is active.
 * @returns True when a display is available; false when browser panes cannot be supported.
 */
export function ensureVirtualDisplayForHeadlessServe(options: { isServeMode: boolean }): boolean {
  if (!options.isServeMode || process.platform !== 'linux') {
    return process.platform !== 'linux'
  }

  configureHeadlessServeChromiumFlags()

  // Offscreen serve windows require X11; Wayland alone still needs Xvfb.
  // Never delete artifacts from an externally managed display: a container may
  // expose its socket without the host lock/PID being visible here.
  const configuredDisplay = process.env.DISPLAY?.trim()
  if (configuredDisplay) {
    if (hasUsableXDisplay(configuredDisplay)) {
      return true
    }
    console.warn(
      `[serve] DISPLAY=${configuredDisplay} is not verifiably live; leaving it untouched. ` +
        'Unset DISPLAY to let Orca start its own Xvfb.'
    )
    return false
  }

  return withVirtualDisplayStartupLock(VIRTUAL_DISPLAY_NUMBER, () => {
    // Why: reuse an existing display if a live X server already backs it.
    if (
      isUnixSocket(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER)) &&
      probeDisplayLock(VIRTUAL_DISPLAY_NUMBER) === 'alive'
    ) {
      process.env.DISPLAY = VIRTUAL_DISPLAY
      return true
    }

    // Stale socket/lock cleanup before fresh Xvfb attempts to bind :99.
    if (isUnixSocket(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER))) {
      removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
    } else if (isStaleDisplayLock(VIRTUAL_DISPLAY_NUMBER)) {
      console.warn(
        `[serve] Detected stale display lock at ${xDisplayLockPath(VIRTUAL_DISPLAY_NUMBER)} ` +
          'without an active server. Cleaning up prior to starting Xvfb.'
      )
      removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
    }

    try {
      xvfbProcess = spawn(
        'Xvfb',
        [VIRTUAL_DISPLAY, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-terminate'],
        {
          stdio: 'ignore',
          detached: true
        }
      )
      xvfbProcess.once('error', (error) => {
        console.warn(
          '[serve] Xvfb failed to start:',
          error instanceof Error ? error.message : error
        )
      })
      // PATH lookup failures emit asynchronously, but a successful spawn has a PID immediately.
      if (xvfbProcess.pid === undefined) {
        xvfbProcess = null
        return false
      }
    } catch (error) {
      console.warn(
        '[serve] Could not start Xvfb:',
        error instanceof Error ? error.message : String(error)
      )
      return false
    }

    if (!waitForDisplayReady(VIRTUAL_DISPLAY_NUMBER, Date.now() + XVFB_STARTUP_TIMEOUT_MS)) {
      console.warn(
        `[serve] Xvfb did not take ownership of ${VIRTUAL_DISPLAY}; browser panes are unavailable. ` +
          'A stale socket from another user can block the rebind.'
      )
      stopVirtualDisplay()
      return false
    }

    process.env.DISPLAY = VIRTUAL_DISPLAY

    // Why: -terminate only takes effect after Xvfb accepts its first client.
    process.once('exit', stopVirtualDisplay)
    app.once('ready', () => process.removeListener('exit', stopVirtualDisplay))

    return true
  })
}

/**
 * Stops any virtual X display process (Xvfb) spawned by ensureVirtualDisplayForHeadlessServe.
 */
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
