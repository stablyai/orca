import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
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

// Why: a socket file can outlive the X server that made it. The X lock file holds
// the server PID; if that process is gone, the display is dead despite the socket.
function isDisplayServerAlive(displayNumber: number): boolean {
  const lockPath = xDisplayLockPath(displayNumber)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  } catch {
    // Missing or unreadable lock means no server claimed this display.
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    // signal 0 probes existence without affecting the process.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
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
  return isUnixSocket(xvfbSocketPath(displayNumber)) && isDisplayServerAlive(displayNumber)
}

function hasUsableWaylandDisplay(env: NodeJS.ProcessEnv): boolean {
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

  if (!hasXvfbBinary()) {
    console.warn(
      '[serve] Xvfb not found; browser panes are unavailable on this headless Linux host. ' +
        `${XVFB_INSTALL_GUIDANCE} Set DISPLAY to enable them with an existing X server.`
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

  // Why: -terminate only takes effect after Xvfb accepts its first client.
  process.once('exit', stopVirtualDisplay)
  app.once('ready', () => process.removeListener('exit', stopVirtualDisplay))

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
