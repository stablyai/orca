import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  displayOwnership,
  hasAbstractXSocket,
  isForeignDisplayServerAlive,
  isManagedDisplayServerAlive,
  isUnixSocket,
  readDisplayLockPid,
  removeStaleDisplayArtifacts,
  xvfbSocketPath
} from './x-display-artifacts'

// Why: headless `orca serve` backs browser panes with offscreen BrowserWindows.
// On Linux, Electron has no display platform without an X server and segfaults
// when such a window loads a page (verified: --headless/--ozone-platform=headless
// also crash; only a virtual display works). So before app.whenReady, ensure a
// virtual X display via Xvfb when none is present. macOS/Windows need nothing.

const XVFB_STARTUP_TIMEOUT_MS = 5_000
const XVFB_POLL_INTERVAL_MS = 50
// Why a range: accounts on one machine each need their own display (#26602); :99 stays the first choice.
const FIRST_VIRTUAL_DISPLAY_NUMBER = 99
const VIRTUAL_DISPLAY_NUMBER_COUNT = 32
const XVFB_INSTALL_GUIDANCE =
  'install an X virtual framebuffer: `xvfb` on Debian/Ubuntu, `xorg-x11-server-Xvfb` on RPM-based systems, or `xorg-server-xvfb` on Arch.'

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

function isManagedDisplayNumber(displayNumber: number): boolean {
  return (
    displayNumber >= FIRST_VIRTUAL_DISPLAY_NUMBER &&
    displayNumber < FIRST_VIRTUAL_DISPLAY_NUMBER + VIRTUAL_DISPLAY_NUMBER_COUNT
  )
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
// Why our PID in the lock: another account's server may win the same free number between our
// check and our Xvfb's bind, and its live lock must not read as our display being ready.
type DisplayStart = 'ready' | 'taken' | 'timeout'

function waitForDisplayReady(
  displayNumber: number,
  xvfbPid: number,
  deadline: number
): DisplayStart {
  const probe = (): DisplayStart | null => {
    const lockPid = readDisplayLockPid(displayNumber)
    if (lockPid === null) {
      return null
    }
    if (lockPid !== xvfbPid) {
      return isManagedDisplayServerAlive(displayNumber) ? 'taken' : null
    }
    // Why the liveness probe too: lock and socket both survive a SIGKILLed Xvfb.
    return isUnixSocket(xvfbSocketPath(displayNumber)) && isManagedDisplayServerAlive(displayNumber)
      ? 'ready'
      : null
  }
  while (Date.now() < deadline) {
    const state = probe()
    if (state) {
      return state
    }
    sleepSync(XVFB_POLL_INTERVAL_MS)
  }
  return probe() ?? 'timeout'
}

// Validate display syntax and local sockets before Chromium reaches Ozone initialization.
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

export const MISSING_SERVE_DISPLAY_MESSAGE = [
  'Orca serve needs an X display for its browser panes, and could not start its own.',
  `Wayland alone is not enough. To let Orca start one, ${XVFB_INSTALL_GUIDANCE}`,
  'Or set DISPLAY to a running X server.'
].join('\n')

export function missingLinuxDisplayMessage(isServeMode: boolean): string {
  return isServeMode ? MISSING_SERVE_DISPLAY_MESSAGE : MISSING_LINUX_DISPLAY_MESSAGE
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
    // Why :99 is never treated as foreign: Orca's own teardown unlinks the lock before the socket,
    // so a lockless :99 socket is our own half-finished cleanup even when DISPLAY names it. Higher
    // numbers stay foreign-checked: a container may publish them without a lock.
    return displayNumber === FIRST_VIRTUAL_DISPLAY_NUMBER
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

  for (
    let displayNumber = FIRST_VIRTUAL_DISPLAY_NUMBER;
    isManagedDisplayNumber(displayNumber);
    displayNumber += 1
  ) {
    const ownership = displayOwnership(displayNumber)
    if (ownership === 'foreign') {
      continue
    }
    if (ownership === 'mine') {
      // Why: reuse this account's display ONLY if a live X server actually backs it. A crashed
      // prior run can leave an orphan socket; trusting it by path alone would advertise browser
      // support that then fails at tab creation.
      if (isManagedDisplayServerAlive(displayNumber)) {
        if (isUnixSocket(xvfbSocketPath(displayNumber))) {
          process.env.DISPLAY = `:${displayNumber}`
          return true
        }
        // Why: a live lock without its socket is a server still starting; its lock is not ours to remove.
        continue
      }
      // Why: stale socket/lock — clean them up so Xvfb can rebind the display.
      removeStaleDisplayArtifacts(displayNumber)
    }
    const started = startVirtualDisplay(displayNumber)
    if (started === 'ready') {
      return true
    }
    if (started !== 'taken') {
      return false
    }
  }
  console.warn(
    `[serve] Every display from :${FIRST_VIRTUAL_DISPLAY_NUMBER} to :${FIRST_VIRTUAL_DISPLAY_NUMBER + VIRTUAL_DISPLAY_NUMBER_COUNT - 1} belongs to another X server; browser panes are unavailable. Set DISPLAY to a running X server.`
  )
  return false
}

function startVirtualDisplay(displayNumber: number): DisplayStart | 'unavailable' {
  const display = `:${displayNumber}`
  try {
    xvfbProcess = spawn(
      'Xvfb',
      [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-terminate'],
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
      return 'unavailable'
    }
  } catch (error) {
    console.warn(
      '[serve] Could not start Xvfb:',
      error instanceof Error ? error.message : String(error)
    )
    return 'unavailable'
  }

  const started = waitForDisplayReady(
    displayNumber,
    xvfbProcess.pid,
    Date.now() + XVFB_STARTUP_TIMEOUT_MS
  )
  if (started !== 'ready') {
    if (started === 'timeout') {
      console.warn(
        `[serve] Xvfb did not take ownership of ${display}; browser panes are unavailable. ` +
          'A stale socket from another user can block the rebind.'
      )
    }
    stopVirtualDisplay()
    return started
  }

  process.env.DISPLAY = display

  // Why: -terminate only takes effect after Xvfb accepts its first client.
  process.once('exit', stopVirtualDisplay)
  app.once('ready', () => process.removeListener('exit', stopVirtualDisplay))

  return 'ready'
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
