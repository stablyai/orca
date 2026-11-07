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

// Linux offscreen serve needs X11 before ready; Electron headless/Ozone-headless also crash on page load, so provision Xvfb when absent.

const XVFB_STARTUP_TIMEOUT_MS = 5_000
const XVFB_POLL_INTERVAL_MS = 50
// Accounts need separate displays (#26602); prefer :99, then search a range.
const FIRST_VIRTUAL_DISPLAY_NUMBER = 99
const VIRTUAL_DISPLAY_NUMBER_COUNT = 32
const XVFB_INSTALL_GUIDANCE =
  'install an X virtual framebuffer: `xvfb` on Debian/Ubuntu, `xorg-x11-server-Xvfb` on RPM-based systems, or `xorg-server-xvfb` on Arch.'

let xvfbProcess: ChildProcess | null = null

function configureHeadlessServeChromiumFlags(): void {
  // Small sandbox /dev/shm mounts can exhaust and crash Chromium utility services; use disk-backed temp.
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  // Opt-in for hosts that expose a GPU to this process (#22450).
  if (process.env.ORCA_SERVE_GPU === '1') {
    return
  }
  // External displays may also be Xvfb; GPU forks can trap before serve readiness.
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
  // Pre-ready startup is synchronous; wait without CPU spinning or a child process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Require our live lock PID plus socket: stale foreign sockets and bind-race winners must not count as our ready Xvfb.
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
    // Socket and lock survive SIGKILL; verify server liveness too.
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
  // Local socket checks cannot prove remote endpoint reachability.
  if (!localDisplay) {
    return /^\S+:\d+(?:\.\d+)?$/.test(display)
  }
  const displayNumber = Number(localDisplay[1])
  if (isUnixSocket(xvfbSocketPath(displayNumber))) {
    // Own lockless :99 may be torn teardown; higher configured displays may be externally published without a lock.
    return displayNumber === FIRST_VIRTUAL_DISPLAY_NUMBER
      ? isManagedDisplayServerAlive(displayNumber)
      : isForeignDisplayServerAlive(displayNumber)
  }
  return hasAbstractXSocket(displayNumber)
}

function hasUsableWaylandDisplay(env: NodeJS.ProcessEnv): boolean {
  // WAYLAND_SOCKET is an inherited connected FD, so no display name/path is required.
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

/** Safe across platforms; false means headless Linux serve cannot support browser panes. */
export function ensureVirtualDisplayForHeadlessServe(options: { isServeMode: boolean }): boolean {
  if (!options.isServeMode || process.platform !== 'linux') {
    return process.platform !== 'linux'
  }

  configureHeadlessServeChromiumFlags()

  // Offscreen serve needs X11 even with Wayland. Never remove externally managed socket artifacts.
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
      // Reuse only a live server: orphan sockets would advertise browser support that crashes on first tab.
      if (isManagedDisplayServerAlive(displayNumber)) {
        if (isUnixSocket(xvfbSocketPath(displayNumber))) {
          process.env.DISPLAY = `:${displayNumber}`
          return true
        }
        // A live lock without its socket belongs to a server still starting; leave it alone.
        continue
      }
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
        // Foreground Ctrl+C must not kill Xvfb before Electron disconnects.
        detached: true
      }
    )
    xvfbProcess.once('error', (error) => {
      console.warn('[serve] Xvfb failed to start:', error instanceof Error ? error.message : error)
    })
    // Successful spawn supplies PID immediately; failed PATH lookup reports asynchronously.
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

  // -terminate waits for a first client; retain explicit cleanup until Electron is ready.
  process.once('exit', stopVirtualDisplay)
  app.once('ready', () => process.removeListener('exit', stopVirtualDisplay))

  return 'ready'
}

export function stopVirtualDisplay(): void {
  if (xvfbProcess && !xvfbProcess.killed) {
    try {
      xvfbProcess.kill()
    } catch {}
  }
  xvfbProcess = null
}
