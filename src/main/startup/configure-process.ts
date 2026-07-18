import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getVersionManagerBinPaths } from '../codex-cli/command'
import { getMainE2EConfig } from '../e2e-config'

const DEV_PARENT_SHUTDOWN_GRACE_MS = 3000
const HTTP1_COMPATIBILITY_ENV_VAR = 'ORCA_DISABLE_HTTP2'
const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off'])
let devParentShutdownRequested = false

type NetworkCompatibilityOptions = {
  env?: NodeJS.ProcessEnv
  userDataPath?: string
}

function parseBooleanEnvFlag(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false
  }
  return null
}

function readPersistedHttp1CompatibilityMode(userDataPath: string): boolean {
  const dataFile = join(userDataPath, 'orca-data.json')
  if (!existsSync(dataFile)) {
    return false
  }

  try {
    const parsed = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
      settings?: { electronHttp1CompatibilityMode?: unknown }
    }
    return parsed.settings?.electronHttp1CompatibilityMode === true
  } catch {
    return false
  }
}

export function shouldDisableHttp2ForElectronNetworking(
  options: NetworkCompatibilityOptions = {}
): boolean {
  const envValue = parseBooleanEnvFlag(options.env?.[HTTP1_COMPATIBILITY_ENV_VAR])
  if (envValue !== null) {
    return envValue
  }
  return readPersistedHttp1CompatibilityMode(options.userDataPath ?? app.getPath('userData'))
}

export function configureElectronNetworkCompatibility(
  options: NetworkCompatibilityOptions = {}
): void {
  if (!shouldDisableHttp2ForElectronNetworking(options)) {
    return
  }
  // Why: Chromium's HTTP/2 switch is process-wide and only works before the
  // first session exists, so read the persisted setting during early startup.
  app.commandLine.appendSwitch('disable-http2')
}

function getProcessPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function requestDevParentShutdown(): void {
  devParentShutdownRequested = true
  app.quit()

  const forceExitTimer = setTimeout(() => {
    // Why: in dev, losing the supervising parent means this Electron process is
    // already orphaned from the terminal session. We try app.quit() first so
    // normal cleanup still runs, but fall back to app.exit() when macOS quit
    // handlers or window-close guards stall and would otherwise leave Orca
    // hanging after Ctrl+C ends `pnpm dev`.
    app.exit(0)
  }, DEV_PARENT_SHUTDOWN_GRACE_MS)

  forceExitTimer.unref()
}

export function isDevParentShutdownRequested(): boolean {
  return devParentShutdownRequested
}

export function resetDevParentShutdownRequestForTests(): void {
  devParentShutdownRequested = false
}

export function installUncaughtPipeErrorGuard(): void {
  const onUncaughtException = (error: unknown): void => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EIO' ||
        (error as NodeJS.ErrnoException).code === 'EPIPE')
    ) {
      return
    }

    process.off('uncaughtException', onUncaughtException)
    // Why: throwing inside an uncaughtException handler makes Node exit with
    // status 7, hiding the original fault. Re-throw on the next tick so the
    // default fatal-exception path reports the real status and stack.
    setImmediate(() => {
      throw error
    })
  }

  process.on('uncaughtException', onUncaughtException)
}

export function patchPackagedProcessPath(): void {
  if (!app.isPackaged) {
    return
  }

  const home = process.env.HOME ?? ''
  const extraPaths: string[] = []

  if (process.platform !== 'win32') {
    extraPaths.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/snap/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/nix/var/nix/profiles/default/bin'
    )

    if (home) {
      extraPaths.push(
        join(home, 'bin'),
        join(home, '.local/bin'),
        join(home, '.nix-profile/bin'),
        // Why: several agent CLIs ship install scripts that drop binaries into
        // tool-specific ~/.<name>/bin directories (opencode's documented fallback,
        // Pi's vite-plus installer). GUI-launched Electron inherits a minimal PATH
        // without shell rc files, so these stay invisible to `which` probes — and
        // the Agents settings page reports them as "Not installed" even when the
        // user can run them from Terminal. See stablyai/orca#829.
        join(home, '.opencode/bin'),
        join(home, '.vite-plus/bin')
      )
    }
  }

  // Why: CLI tools installed via Node version managers (nvm, volta, asdf, fnm,
  // pnpm, yarn, bun) use #!/usr/bin/env node shebangs that need `node` in PATH.
  // resolveCodexCommand() can locate the codex binary in these directories, but
  // spawning it still fails if node itself isn't in PATH. Adding version manager
  // bin paths here fixes all spawn sites (login, rate limits, usage tracking).
  // On Windows this also seeds user-local installer dirs, since shell hydration
  // is POSIX-only and Start Menu launches can miss user-level PATH updates.
  extraPaths.push(...getVersionManagerBinPaths())

  const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
  const currentPath = process.env[pathKey] ?? ''
  const pathDelimiter = getProcessPathDelimiter()
  const existing = new Set(currentPath.split(pathDelimiter))
  const missing = extraPaths.filter((path) => !existing.has(path))

  if (missing.length > 0) {
    process.env[pathKey] = [...missing, ...currentPath.split(pathDelimiter).filter(Boolean)].join(
      pathDelimiter
    )
  }
}

export function configureDevUserDataPath(isDev: boolean): void {
  const e2eConfig = getMainE2EConfig()
  if (e2eConfig.userDataDir) {
    // Why: the E2E suite launches a fresh Electron app for each spec. A
    // dedicated userData path per launch prevents persisted repos, worktrees,
    // and session state from leaking between tests through the shared dev
    // profile while still leaving the user's real packaged profile untouched.
    app.setPath('userData', e2eConfig.userDataDir)
    return
  }

  if (!isDev) {
    return
  }
  const overrideUserDataPath = process.env.ORCA_DEV_USER_DATA_PATH
  if (overrideUserDataPath) {
    // Why: automated Electron repros need an isolated profile so persisted
    // tabs/worktrees from the developer's normal `orca-dev` session do not
    // change startup behavior and hide or create window-management bugs.
    app.setPath('userData', overrideUserDataPath)
    return
  }
  // Why: development runs share the same machine as packaged Orca, and both
  // publish runtime bootstrap files under userData. Without a dev-only path,
  // `pnpm dev` can overwrite the packaged app's runtime pointer and make the
  // public `orca` CLI look broken even though the packaged app is still open.
  app.setPath('userData', join(app.getPath('appData'), 'orca-dev'))
}

export function configureOrcaUserDataPathEnv(): void {
  // Why: app relaunches can inherit an ORCA_USER_DATA_PATH from an older CLI or
  // updater process. Main must canonicalize it before CLI-shared modules build
  // runtime-home paths, or migrations can bridge two Orca app-data directories.
  process.env.ORCA_USER_DATA_PATH = app.getPath('userData')
}

export function shouldInstallManagedHooks(isDev: boolean): boolean {
  void isDev
  // Why: managed hook installation now targets Orca-owned, environment-scoped
  // homes for Codex rather than the user's default ~/.codex state, so plain
  // dev runs need the install path enabled to keep hook-backed agent statuses
  // accurate without an opt-in flag. The remaining agents still rely on the
  // shared startup installer loop, so keep the policy uniformly on until
  // they are migrated to more granular ownership seams.
  return true
}

export function installDevParentDisconnectQuit(isDev: boolean): void {
  if (!isDev || typeof process.send !== 'function') {
    return
  }

  // Why: electron-vite dev controls the Electron app over Node IPC so it can
  // hot-restart the main process. On macOS, Ctrl+C can stop that parent process
  // without terminating the app window, so in dev we quit explicitly when the
  // supervising IPC channel disconnects instead of leaving a stray Electron app.
  process.once('disconnect', () => {
    requestDevParentShutdown()
  })
}

export function installDevParentWatchdog(isDev: boolean): void {
  if (!isDev) {
    return
  }

  const initialParentPid = process.ppid
  if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) {
    return
  }

  const timer = setInterval(() => {
    const parentPidChanged = process.ppid !== initialParentPid
    let parentMissing = false

    try {
      process.kill(initialParentPid, 0)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      ) {
        parentMissing = true
      } else {
        throw error
      }
    }

    if (parentPidChanged || parentMissing) {
      clearInterval(timer)
      // Why: electron-vite's dev runner starts Electron with plain spawn() and
      // inherited stdio, not an IPC channel. On macOS that means Ctrl+C can end
      // the dev runner while leaving Orca open. Watching the original parent PID
      // keeps dev shutdown coupled to the terminal session without affecting the
      // packaged app, which is not supervised by electron-vite.
      requestDevParentShutdown()
    }
  }, 1000)

  timer.unref()
}

export function installDevParentSignalQuit(isDev: boolean): void {
  if (!isDev) {
    return
  }

  const onSignal = (): void => {
    // Why: run-electron-vite-dev forwards terminal shutdown signals to the
    // Electron process group; those are dev-supervisor shutdowns too, so the
    // detached daemon should not be preserved for warm reattach.
    requestDevParentShutdown()
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

export function enableMainProcessGpuFeatures(): void {
  if (process.platform === 'linux' && getMainE2EConfig().userDataDir) {
    // Why: Ubuntu/Xvfb runners can fail Electron startup with
    // "GPU process isn't usable" before Playwright sees the first window.
    // E2E coverage does not depend on GPU compositing, so keep CI on the
    // software path instead of retrying around a crashed app process.
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    return
  }

  // Why: Blink force-loses the oldest WebGL context past 16 per renderer, and
  // each attached terminal pane holds one — a busy worktree (tabs × splits)
  // can exceed that, silently downgrading evicted panes to the DOM renderer.
  // 128 covers real layouts while keeping a bound so context leaks surface.
  app.commandLine.appendSwitch('max-active-webgl-contexts', '128')

  const ozonePlatform = (app.commandLine.getSwitchValue('ozone-platform') ?? '').toLowerCase()
  const ozonePlatformHint = (process.env.ELECTRON_OZONE_PLATFORM_HINT ?? '').toLowerCase()
  const isLinuxX11Override =
    ozonePlatform === 'x11' || (ozonePlatform === '' && ozonePlatformHint === 'x11')
  const isLinuxWaylandSession =
    process.platform === 'linux' &&
    !isLinuxX11Override &&
    (Boolean(process.env.WAYLAND_DISPLAY) ||
      process.env.XDG_SESSION_TYPE === 'wayland' ||
      ozonePlatformHint === 'wayland' ||
      ozonePlatform === 'wayland')
  if (isLinuxWaylandSession) {
    // Why: #5319 reproduces when Wayland loses the eager GPU channel. Keep
    // acceleration available, but drop the GPU sandbox and let Chromium open
    // the GPU channel lazily on this compositor path.
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  }

  const existingFeatures = app.commandLine.getSwitchValue('enable-features')
  const features = [
    // Why: mirror VS Code's conservative Electron GPU-channel startup flags
    // instead of opting into Vulkan/SkiaGraphite/unsafe WebGPU globally.
    // Terminal acceleration is controlled by xterm WebGL in the renderer.
    ...(isLinuxWaylandSession ? [] : ['EarlyEstablishGpuChannel', 'EstablishGpuChannelAsync']),
    existingFeatures
  ]
    .filter(Boolean)
    .join(',')
  if (features) {
    app.commandLine.appendSwitch('enable-features', features)
  }

  const existingDisabledFeatures = app.commandLine.getSwitchValue('disable-features')
  // Why: with main-window background throttling on, Chromium's intensive mode
  // clamps hidden-page timers to 1/min after 5 minutes, delaying agent-done and
  // bell notifications by up to 60s. Keep the normal 1s hidden clamp (rAF and
  // rendering still stop) but opt out of the 1/min tier. Callers skip this
  // function under GPU fallback (win32-only today); if throttling ever extends
  // to Windows, this opt-out must move out of the GPU-gated path.
  const disabledFeatures = ['IntensiveWakeUpThrottling', existingDisabledFeatures]
    .filter(Boolean)
    .join(',')
  app.commandLine.appendSwitch('disable-features', disabledFeatures)
}
