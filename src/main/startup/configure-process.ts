import { app } from 'electron'
import { quitProcess } from './process-quit-request'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getVersionManagerBinPaths } from '../codex-cli/command'
import { isWindowsFnmDefaultAliasDir } from '../../shared/fnm-default-alias-dirs'
import { getMainE2EConfig } from '../e2e-config'
import { DISABLED_CHROMIUM_FEATURES } from './disabled-chromium-features'
import { readHttp1CompatibilityMarker } from './http1-compatibility-marker'
import { checkServeUserDataPath } from './serve-user-data-path-guard'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { isLinuxWaylandSession } from '../../shared/linux-wayland-session'
import {
  hasMissingProfileStateDatabaseWithRetainedAuthority,
  readActiveProfileId,
  readPersistedHttp1CompatibilityMode
} from './http1-compatibility-profile-state'

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

export function shouldDisableHttp2ForElectronNetworking(
  options: NetworkCompatibilityOptions = {}
): boolean {
  const envValue = parseBooleanEnvFlag(options.env?.[HTTP1_COMPATIBILITY_ENV_VAR])
  if (envValue !== null) {
    return envValue
  }
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const activeProfileId = readActiveProfileId(userDataPath)
  // Read the small marker before parsing settings again; untrusted SQLite profiles fail closed rather than revive JSON.
  if (
    activeProfileId !== undefined &&
    activeProfileId !== null &&
    hasMissingProfileStateDatabaseWithRetainedAuthority(userDataPath, activeProfileId)
  ) {
    return false
  }
  return (
    (activeProfileId === null
      ? null
      : readHttp1CompatibilityMarker(userDataPath, activeProfileId)) ??
    readPersistedHttp1CompatibilityMode(userDataPath)
  )
}

export function configureElectronNetworkCompatibility(
  options: NetworkCompatibilityOptions = {}
): void {
  if (!shouldDisableHttp2ForElectronNetworking(options)) {
    return
  }
  // HTTP/2 selection is process-wide and must precede the first Electron session.
  app.commandLine.appendSwitch('disable-http2')
}

export function disableUnsupportedChromiumFeatures(): void {
  appendDisabledChromiumFeatures([...DISABLED_CHROMIUM_FEATURES])
}

// Hidden-page timers otherwise clamp to once/minute after five minutes, delaying agent notifications on every platform.
export function optOutOfHiddenPageWakeUpThrottling(): void {
  appendDisabledChromiumFeatures(['IntensiveWakeUpThrottling'])
}

function appendDisabledChromiumFeatures(features: string[]): void {
  const existingFeatures = app.commandLine
    .getSwitchValue('disable-features')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)
  const disabledFeatures = Array.from(new Set([...features, ...existingFeatures])).join(',')
  app.commandLine.appendSwitch('disable-features', disabledFeatures)
}

function getProcessPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function requestDevParentShutdown(): void {
  devParentShutdownRequested = true
  quitProcess()

  const forceExitTimer = setTimeout(() => {
    // Force exit after grace: macOS quit handlers/window guards can stall dev shutdown.
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

export function patchPackagedProcessPath(): void {
  if (!app.isPackaged) {
    return
  }

  const home = process.env.HOME ?? ''
  // #18234: append generic user bins; prepending ~/.local/bin made a gh/mise wrapper recursively shadow system gh. Shell hydration owns user ordering.
  const isGenericUserBinDir = (path: string): boolean =>
    process.platform !== 'win32' &&
    home !== '' &&
    (path === join(home, 'bin') || path === join(home, '.local/bin'))
  const appendPaths: string[] = []
  // Version-manager shims must lead to preserve the selected runtime.
  const prependPaths: string[] = []

  if (process.platform !== 'win32') {
    appendPaths.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin')

    if (process.platform === 'linux') {
      // Avoid phantom snap/Linuxbrew paths on non-Linux hosts.
      appendPaths.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin')
    }

    appendPaths.push('/nix/var/nix/profiles/default/bin')

    if (home) {
      appendPaths.push(
        join(home, 'bin'),
        join(home, '.local/bin'),
        join(home, '.nix-profile/bin'),
        // GUI PATH omits agent-specific install directories (#829).
        join(home, '.opencode/bin'),
        join(home, '.vite-plus/bin'),
        join(home, '.grok/bin')
      )
    }
  }

  // env-node shebangs require runtime shims; exclude generic user bins so arbitrary wrappers cannot shadow system tools.
  for (const path of getVersionManagerBinPaths()) {
    if (isWindowsFnmDefaultAliasDir(path)) {
      appendPaths.push(path)
    } else if (!isGenericUserBinDir(path)) {
      prependPaths.push(path)
    }
  }

  const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
  const currentPath = process.env[pathKey] ?? ''
  const pathDelimiter = getProcessPathDelimiter()
  const currentSegments = currentPath.split(pathDelimiter).filter(Boolean)
  const existing = new Set(currentSegments)
  const prepend = prependPaths.filter((path) => !existing.has(path))
  const append = appendPaths.filter((path) => !existing.has(path) && !prepend.includes(path))

  if (prepend.length > 0 || append.length > 0) {
    process.env[pathKey] = [...prepend, ...currentSegments, ...append].join(pathDelimiter)
  }
}

export function configureDevUserDataPath(isDev: boolean): void {
  const e2eConfig = getMainE2EConfig()
  if (e2eConfig.userDataDir) {
    // Isolate each E2E launch from persisted profiles while leaving the real packaged profile untouched.
    const e2eHomeDir = process.env.ORCA_E2E_HOME_DIR ?? join(e2eConfig.userDataDir, 'home')
    // Imports can resolve homedir before Electron readiness; reject launches outside disposable Node home.
    if (!areSameE2EHomePath(homedir(), e2eHomeDir)) {
      throw new Error('Refusing to start E2E outside its disposable home boundary')
    }
    // macOS Electron reads home from the native user database, so set it before building Codex paths.
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
    // Why: run-electron-vite-dev.mjs resolves a per-worktree (or shared orca-dev) profile here; repros also pass isolated ones.
    app.setPath('userData', overrideUserDataPath)
    return
  }
  // Why: launches that bypass the dev runner still need a dev-only path, or they overwrite the packaged app's runtime pointer under userData and break the orca CLI.
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
  const userDataPath = app.getPath('userData')
  // Validate final userData before instance locking; preflight catches refusals and exits serve.
  const serveProfileRefusal = checkServeUserDataPath({
    isServeMode: process.argv.includes('--serve'),
    userDataPath
  })
  if (serveProfileRefusal) {
    throw new Error(serveProfileRefusal)
  }
  // Canonicalize stale inherited profile overrides before CLI modules derive runtime-home paths.
  process.env.ORCA_USER_DATA_PATH = userDataPath
  // An Orca launched from another Orca terminal must own its CLI children.
  stampRuntimeSourceEnv(process.env, null)
}

export function shouldInstallManagedHooks(isDev: boolean): boolean {
  void isDev
  // Codex hooks now target Orca-owned homes; retain installation until every agent has its own seam.
  return true
}

export function installDevParentDisconnectQuit(isDev: boolean): void {
  if (!isDev || typeof process.send !== 'function') {
    return
  }

  // macOS Ctrl+C can stop electron-vite without closing Electron; couple shutdown to IPC disconnect.
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
      // Dev launches lack IPC; parent-PID monitoring closes Electron after macOS Ctrl+C.
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
    // Forwarded dev shutdown must also stop the detached daemon rather than preserve warm reattach.
    requestDevParentShutdown()
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

export function enableMainProcessGpuFeatures(): void {
  if (process.platform === 'linux' && getMainE2EConfig().userDataDir) {
    // Ubuntu/Xvfb E2E needs software rendering to avoid GPU-process startup failure.
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    return
  }

  if (process.platform === 'darwin') {
    // Graphite can retain corrupt Metal tiles after idle. Keep this macOS fix unconditional if GPU fallback ever expands beyond win32.
    app.commandLine.appendSwitch('disable-skia-graphite')
  }

  // Each terminal consumes WebGL context capacity; raise the default 16 limit while keeping leaks bounded.
  app.commandLine.appendSwitch('max-active-webgl-contexts', '128')

  const waylandSession = isLinuxWaylandSession({
    platform: process.platform,
    env: process.env,
    ozonePlatform: app.commandLine.getSwitchValue('ozone-platform')
  })
  if (waylandSession) {
    // #5319: drop the Wayland GPU sandbox so Chromium opens the lost eager channel lazily.
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  }

  const existingFeatures = app.commandLine.getSwitchValue('enable-features')
  const features = [
    // Use conservative GPU-channel flags; xterm acceleration needs WebGL rather than global Vulkan/Graphite/WebGPU.
    ...(waylandSession ? [] : ['EarlyEstablishGpuChannel', 'EstablishGpuChannelAsync']),
    existingFeatures
  ]
    .filter(Boolean)
    .join(',')
  if (features) {
    app.commandLine.appendSwitch('enable-features', features)
  }
}
