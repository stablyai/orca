import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
  // Why: Chromium's HTTP/2 switch is process-wide and only applies before the first session exists, so set it during early startup.
  app.commandLine.appendSwitch('disable-http2')
}

function getProcessPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function requestDevParentShutdown(): void {
  devParentShutdownRequested = true
  app.quit()

  const forceExitTimer = setTimeout(() => {
    // Why: app.quit() may stall on macOS quit handlers or window-close guards, so force-exit after a grace period to avoid a hung dev app.
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
    // Why: throwing inside an uncaughtException handler exits with status 7 and hides the fault; re-throw next tick for the real stack.
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
        // Why: some agent CLIs install into ~/.<name>/bin; GUI-launched Electron's minimal PATH misses them (stablyai/orca#829).
        join(home, '.opencode/bin'),
        join(home, '.vite-plus/bin')
      )
    }
  }

  // Why: version-manager CLIs use env-node shebangs, so node must be on PATH or spawns fail (also seeds Windows user-local dirs).
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
    const e2eHomeDir = process.env.ORCA_E2E_HOME_DIR ?? join(e2eConfig.userDataDir, 'home')
    // Why: E2E imports can resolve os.homedir() before Electron is ready. Abort
    // startup if a direct launch skipped the disposable Node-home contract.
    if (!areSameE2EHomePath(homedir(), e2eHomeDir)) {
      throw new Error('Refusing to start E2E outside its disposable home boundary')
    }
    // Why: on macOS Electron resolves app.getPath('home') from the native user
    // database, not HOME. Set it explicitly before any Codex paths are built.
    mkdirSync(e2eHomeDir, { recursive: true, mode: 0o700 })
    app.setPath('home', e2eHomeDir)
    app.setPath('userData', e2eConfig.userDataDir)
    return
  }

  if (!isDev) {
    return
  }
  const overrideUserDataPath = process.env.ORCA_DEV_USER_DATA_PATH
  if (overrideUserDataPath) {
    // Why: automated repros need an isolated profile so the dev's persisted tabs/worktrees don't skew startup and hide window bugs.
    app.setPath('userData', overrideUserDataPath)
    return
  }
  // Why: without a dev-only path, pnpm dev overwrites the packaged app's runtime pointer under userData and breaks the orca CLI.
  app.setPath('userData', join(app.getPath('appData'), 'orca-dev'))
}

function areSameE2EHomePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function configureOrcaUserDataPathEnv(): void {
  // Why: relaunches can inherit a stale ORCA_USER_DATA_PATH; canonicalize before CLI-shared modules build runtime-home paths.
  process.env.ORCA_USER_DATA_PATH = app.getPath('userData')
}

export function shouldInstallManagedHooks(isDev: boolean): boolean {
  void isDev
  // Why: managed hooks now target Orca-owned Codex homes, not ~/.codex, so keep install on for all agents until each gets its own seam.
  return true
}

export function installDevParentDisconnectQuit(isDev: boolean): void {
  if (!isDev || typeof process.send !== 'function') {
    return
  }

  // Why: on macOS Ctrl+C can stop the electron-vite parent without closing the window, so quit when the IPC channel disconnects.
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
      // Why: the dev runner spawns Electron without IPC, so on macOS Ctrl+C leaves Orca open; watch the parent PID to couple shutdown.
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
    // Why: run-electron-vite-dev forwards terminal shutdown signals here, so don't preserve the detached daemon for warm reattach.
    requestDevParentShutdown()
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

export function enableMainProcessGpuFeatures(): void {
  if (process.platform === 'linux' && getMainE2EConfig().userDataDir) {
    // Why: Ubuntu/Xvfb runners fail Electron startup with "GPU process isn't usable"; E2E needs no GPU, so use the software path.
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    return
  }

  // Why: Blink evicts the oldest WebGL context past 16/renderer and each terminal pane holds one, silently downgrading panes to DOM.
  // 128 raises the ceiling for real layouts while staying bounded so context leaks still surface.
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
    // Why: #5319 — Wayland loses the eager GPU channel; drop the GPU sandbox so Chromium opens it lazily.
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  }

  const existingFeatures = app.commandLine.getSwitchValue('enable-features')
  const features = [
    // Why: mirror VS Code's conservative GPU-channel flags instead of global Vulkan/SkiaGraphite/WebGPU; terminal accel is xterm WebGL.
    ...(isLinuxWaylandSession ? [] : ['EarlyEstablishGpuChannel', 'EstablishGpuChannelAsync']),
    existingFeatures
  ]
    .filter(Boolean)
    .join(',')
  if (features) {
    app.commandLine.appendSwitch('enable-features', features)
  }

  const existingDisabledFeatures = app.commandLine.getSwitchValue('disable-features')
  // Why: IntensiveWakeUpThrottling clamps hidden-page timers to 1/min after 5min, delaying agent-done/bell notifications ~60s.
  // This opt-out is skipped under GPU fallback (win32-only today); if throttling ever reaches Windows it must move out of this path.
  const disabledFeatures = ['IntensiveWakeUpThrottling', existingDisabledFeatures]
    .filter(Boolean)
    .join(',')
  app.commandLine.appendSwitch('disable-features', disabledFeatures)
}
