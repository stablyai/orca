import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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

function xvfbSocketPath(displayNumber: number): string {
  return `/tmp/.X11-unix/X${displayNumber}`
}

function xDisplayLockPath(displayNumber: number): string {
  return `/tmp/.X${displayNumber}-lock`
}

// Why: a socket file can outlive the X server that made it. The X lock file holds the server PID;
// if that process is gone, the display is dead despite the socket. `missing` is a third outcome the
// two callers must treat differently — see each call site.
type DisplayLockProbe = 'alive' | 'dead' | 'missing'

function probeDisplayLock(displayNumber: number): DisplayLockProbe {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim(), 10)
  } catch (error) {
    // An unreadable lock is a lock we cannot clear: treat it as dead, not absent.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'dead'
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'dead'
  }
  try {
    // signal 0 probes existence without affecting the process.
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    // EPERM means the PID exists under another uid — a root-owned X server is still live.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
      ? 'alive'
      : 'dead'
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
export function isStaleDisplayLock(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) === 'dead'
}

/**
 * Liveness for a display Orca did not create. An X server writes its lock beside the socket and
 * both survive a crash (verified against Xvfb under SIGKILL), so a socket with no lock was never
 * left by a crashed server — it is an endpoint published from elsewhere: a container bind-mounting
 * only /tmp/.X11-unix, WSLg, or a foreign PID namespace. We cannot judge those, and refusing them
 * blocks startup on displays that work.
 *
 * @param displayNumber - The X11 display number (e.g. 99 for :99).
 * @returns True if the foreign display server is not dead; otherwise false.
 */
function isForeignDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) !== 'dead'
}

/**
 * Liveness for Orca's own VIRTUAL_DISPLAY_NUMBER. Stricter on purpose: `removeStaleDisplayArtifacts`
 * unlinks the lock before the socket, so a lockless socket here is Orca's own half-finished
 * teardown, not a foreign endpoint. Adopting it would resurrect the orphan-socket bug and stop the
 * cleanup below from self-healing.
 *
 * @param displayNumber - The X11 display number (e.g. 99 for :99).
 * @returns True if Orca's managed display server process is actively alive; otherwise false.
 */
function isManagedDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) === 'alive'
}

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
  // Why: this runs in the synchronous pre-whenReady startup path, so block
  // without spinning the CPU or spawning a process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Why not socket presence alone: a stale socket we failed to unlink (a root-owned one left by a
// crashed system Xvfb, which `User=orca` serve cannot remove) still exists after our own Xvfb
// refused to bind the display. Treating that as ready sets DISPLAY to a dead server and Chromium
// dies in Ozone init with SIGSEGV instead of reporting an unusable display.
function waitForDisplayReady(displayNumber: number, deadline: number): boolean {
  const isReady = (): boolean =>
    isUnixSocket(xvfbSocketPath(displayNumber)) && isManagedDisplayServerAlive(displayNumber)
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

  const ozonePlatform = app.commandLine.getSwitchValue('ozone-platform').trim().toLowerCase()
  const ozonePlatformHint = env.ELECTRON_OZONE_PLATFORM_HINT?.trim().toLowerCase()
  const selectedPlatform =
    ozonePlatform === 'x11' || ozonePlatform === 'wayland'
      ? ozonePlatform
      : ozonePlatformHint === 'x11' || ozonePlatformHint === 'wayland'
        ? ozonePlatformHint
        : null

  if (selectedPlatform === 'x11') {
    return hasUsableXDisplay(env.DISPLAY)
  }
  if (selectedPlatform === 'wayland') {
    return hasUsableWaylandDisplay(env)
  }
  return hasUsableXDisplay(env.DISPLAY) || hasUsableWaylandDisplay(env)
}

export const MISSING_LINUX_DISPLAY_MESSAGE = [
  'Orca needs a usable display server, but the selected X11 or Wayland endpoint is unavailable.',
  'Check DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and any --ozone-platform override.',
  `Use \`orca-ide serve\` to run headless. On a bare server, ${XVFB_INSTALL_GUIDANCE}`
].join('\n')

// Why: an X server may bind only the abstract namespace (`@/tmp/.X11-unix/X0`), which leaves no
// filesystem socket to stat. Abstract addresses are kernel-owned and vanish the moment the owner
// exits, so an entry here is proof of a live server — no lock file needed, and no stale entry is
// possible. Refusing these was a hard startup failure with no workaround.
function hasAbstractXSocket(displayNumber: number): boolean {
  let table: unknown
  try {
    table = readFileSync('/proc/net/unix', 'utf8')
  } catch {
    return false
  }
  if (typeof table !== 'string') {
    return false
  }
  const address = `@${xvfbSocketPath(displayNumber)}`
  return table
    .split('\n')
    .some((line) => line.slice(line.lastIndexOf(' ') + 1).trimEnd() === address)
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
  // Remote endpoints cannot be proven with local socket checks.
  if (!localDisplay) {
    return /^\S+:\d+(?:\.\d+)?$/.test(display)
  }
  const displayNumber = Number(localDisplay[1])
  if (isUnixSocket(xvfbSocketPath(displayNumber))) {
    // Why the managed number is never treated as foreign: Orca's own teardown unlinks the lock
    // before the socket, so a lockless socket on VIRTUAL_DISPLAY_NUMBER is our own half-finished
    // cleanup even when DISPLAY names it explicitly. Trusting it there would accept a dead display.
    return displayNumber === VIRTUAL_DISPLAY_NUMBER
      ? isManagedDisplayServerAlive(displayNumber)
      : isForeignDisplayServerAlive(displayNumber)
  }
  return hasAbstractXSocket(displayNumber)
}

function hasUsableWaylandDisplay(env: NodeJS.ProcessEnv): boolean {
  // Why: WAYLAND_SOCKET is an already-connected fd handed over by the compositor, so there is no
  // path to stat and WAYLAND_DISPLAY may be unset entirely. Its presence IS the display.
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

  // Why: reuse an existing display ONLY if a live X server actually backs it.
  // A crashed prior run can leave an orphan socket; trusting it by path alone
  // would advertise browser support that then fails at tab creation.
  if (isUnixSocket(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER))) {
    if (isManagedDisplayServerAlive(VIRTUAL_DISPLAY_NUMBER)) {
      process.env.DISPLAY = VIRTUAL_DISPLAY
      return true
    }
    // Why: stale socket/lock — clean them up so Xvfb can rebind the display
    // below instead of refusing to start on an "in use" number.
    removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
  } else if (isStaleDisplayLock(VIRTUAL_DISPLAY_NUMBER)) {
    // Orphan lock file with no socket, left by unclean exit or dead PID.
    // Unconditionally remove stale lock artifacts before Xvfb attempts to bind :99.
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
        // Why: foreground Ctrl-C must not kill Xvfb before Electron disconnects.
        detached: true
      }
    )
    xvfbProcess.once('error', (error) => {
      console.warn('[serve] Xvfb failed to start:', error instanceof Error ? error.message : error)
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

  const ready = waitForDisplayReady(VIRTUAL_DISPLAY_NUMBER, Date.now() + XVFB_STARTUP_TIMEOUT_MS)
  if (!ready) {
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
