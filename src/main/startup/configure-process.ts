import { app } from 'electron'
import { join } from 'path'
import { getVersionManagerBinPaths } from '../codex-cli/command'
import { getMainE2EConfig } from '../e2e-config'

const DEV_PARENT_SHUTDOWN_GRACE_MS = 3000

function requestDevParentShutdown(): void {
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

export function installUncaughtPipeErrorGuard(): void {
  process.on('uncaughtException', (error) => {
    if (
      error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EIO' ||
        (error as NodeJS.ErrnoException).code === 'EPIPE')
    ) {
      return
    }

    throw error
  })
}

export function patchPackagedProcessPath(): void {
  if (!app.isPackaged || process.platform === 'win32') {
    return
  }

  const home = process.env.HOME ?? ''
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/nix/var/nix/profiles/default/bin'
  ]

  if (home) {
    extraPaths.push(join(home, '.local/bin'), join(home, '.nix-profile/bin'))
  }

  // Why: CLI tools installed via Node version managers (nvm, volta, asdf, fnm,
  // pnpm, yarn, bun) use #!/usr/bin/env node shebangs that need `node` in PATH.
  // resolveCodexCommand() can locate the codex binary in these directories, but
  // spawning it still fails if node itself isn't in PATH. Adding version manager
  // bin paths here fixes all spawn sites (login, rate limits, usage tracking).
  extraPaths.push(...getVersionManagerBinPaths())

  const currentPath = process.env.PATH ?? ''
  const existing = new Set(currentPath.split(':'))
  const missing = extraPaths.filter((path) => !existing.has(path))

  if (missing.length > 0) {
    process.env.PATH = [...missing, ...currentPath.split(':').filter(Boolean)].join(':')
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

function isLinuxWaylandSession(): boolean {
  // Why: WAYLAND_DISPLAY is set directly by the Wayland compositor and is the
  // same signal Electron's own ELECTRON_OZONE_PLATFORM_HINT=auto logic uses.
  // XDG_SESSION_TYPE is the login-manager/PAM signal and is the belt-and-
  // suspenders check for sessions where WAYLAND_DISPLAY isn't set at process
  // start (nested Wayland, manual session startup). Both are inherited from
  // the parent process, so they're available before app.whenReady where the
  // GPU command-line switches must be appended.
  return (
    process.platform === 'linux' &&
    (Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland')
  )
}

export function enableMainProcessGpuFeatures(): void {
  // Why: Chromium's Ozone/Wayland surface factory hard-aborts when Vulkan is
  // enabled (see wayland_surface_factory.cc:251 — "--ozone-platform=wayland is
  // not compatible with Vulkan"), leaving the renderer unable to compose and
  // showing a blank/transparent window on Wayland-default distros like
  // Arch/Omarchy/Hyprland and GNOME-Wayland. Skia Graphite is Vulkan-only on
  // Linux (no OpenGL backend), so enabling it with Vulkan off would silently
  // fall back to software rendering — gate it on the same Wayland signal.
  // The X11 Vulkan path works, so we keep the acceleration there and on
  // macOS/Windows.
  if (isLinuxWaylandSession()) {
    return
  }
  app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaGraphite')
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}
