import { app as electronApp, BaseWindow, type BrowserWindow } from 'electron'

/** Automation must not steal OS foreground. Background/sidecar requests override E2E_FOREGROUND; the hosted-Xvfb benchmark may present explicitly after startup (tests/AGENTS.md), while automatic reveals stay suppressed. */

type ActivationPolicyApp = {
  dock?: { hide: () => void; show?: () => Promise<void> }
  setActivationPolicy: (policy: 'accessory' | 'prohibited' | 'regular') => void
}

type PolicyEnv = Readonly<Record<string, string | undefined>>

/** orcad's headless browser provider: a serve process on a throwaway profile that no user drives. */
export function isOrcadSidecarLaunch(env: PolicyEnv = process.env): boolean {
  return env.ORCA_ORCAD_SIDECAR === '1'
}

function isExplicitBackgroundLaunch(env: PolicyEnv): boolean {
  return env.ORCA_BACKGROUND_LAUNCH === '1' || isOrcadSidecarLaunch(env)
}

/** True when this process must not steal focus, raise windows, or activate the app. */
export function isBackgroundLaunch(env: PolicyEnv = process.env): boolean {
  if (isExplicitBackgroundLaunch(env)) {
    return true
  }
  if (env.ORCA_E2E_FOREGROUND === '1') {
    return false
  }
  return env.ORCA_E2E_HEADLESS === '1' || env.ORCA_E2E_HEADFUL === '1'
}

/** Suppresses automatic presentation on launch; this is not a query of current window visibility. */
export function isWindowlessLaunch(env: PolicyEnv = process.env): boolean {
  return (
    isExplicitBackgroundLaunch(env) ||
    (isBackgroundLaunch(env) && env.ORCA_E2E_HEADLESS === '1' && env.ORCA_E2E_HEADFUL !== '1')
  )
}

type ActivationPolicyOptions = {
  app?: ActivationPolicyApp
  env?: PolicyEnv
  platform?: NodeJS.Platform
  /** `orca serve` with no desktop window open: a server, not an app to switch to or quit (#16061). */
  serveWithoutDesktopWindow?: boolean
  warn?: (message: string, error: unknown) => void
}

/** macOS accessory policy hides Dock/menu-bar claims during windowless launch/exit while retaining programmatic activation. */
export function applyBackgroundActivationPolicy(options: ActivationPolicyOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  if (
    platform !== 'darwin' ||
    !(options.serveWithoutDesktopWindow || isWindowlessLaunch(options.env ?? process.env))
  ) {
    return false
  }
  try {
    const app = options.app ?? electronApp
    app.dock?.hide()
    app.setActivationPolicy('accessory')
    return true
  } catch (error) {
    options.warn?.('[window] Failed to apply background activation policy', error)
    return false
  }
}

/** Gives a serve process its Dock tile and menu bar back while it hosts a desktop window. */
export function applyServeDesktopWindowActivationPolicy(
  options: Omit<ActivationPolicyOptions, 'serveWithoutDesktopWindow'> = {}
): boolean {
  const platform = options.platform ?? process.platform
  // dock.show() activates the app, so automated launches keep the accessory policy.
  if (platform !== 'darwin' || isBackgroundLaunch(options.env ?? process.env)) {
    return false
  }
  try {
    const app = options.app ?? electronApp
    app.setActivationPolicy('regular')
    void app.dock?.show?.().catch((error: unknown) => {
      options.warn?.('[window] Failed to show the Dock icon', error)
    })
    return true
  } catch (error) {
    options.warn?.('[window] Failed to apply foreground activation policy', error)
    return false
  }
}

/**
 * Reveal a window without taking the foreground: hidden entirely when windowless,
 * `showInactive()` for explicitly headful E2E runs.
 */
export function showWindowWithoutStealingFocus(
  window: BrowserWindow,
  env: PolicyEnv = process.env
): void {
  if (window.isDestroyed()) {
    return
  }
  if (isWindowlessLaunch(env)) {
    return
  }
  if (isBackgroundLaunch(env)) {
    window.showInactive()
    return
  }
  window.show()
}

// Popups waiting for the user to come back share one pair of app listeners.
const windowsAwaitingAppActive = new Set<BaseWindow>()

function stopAwaitingAppActive(): void {
  electronApp.off('browser-window-focus', revealWindowsAwaitingAppActive)
  electronApp.off('did-become-active', revealWindowsAwaitingAppActive)
}

/** The user is back in Orca. Origin-bar popups (plain BaseWindows) call this on focus, since only BrowserWindows raise `browser-window-focus`. */
export function revealWindowsAwaitingAppActive(): void {
  if (windowsAwaitingAppActive.size === 0) {
    return
  }
  stopAwaitingAppActive()
  for (const window of windowsAwaitingAppActive) {
    if (!window.isDestroyed()) {
      window.showInactive()
    }
  }
  windowsAwaitingAppActive.clear()
}

/** Shows a window an agent opened without activating Orca: now if Orca is in front, else once the user returns to it. */
export function showWhenAppActive(window: BaseWindow, env: PolicyEnv = process.env): void {
  if (window.isDestroyed() || isWindowlessLaunch(env)) {
    return
  }
  // Any Orca window counts, including origin-bar popups (plain BaseWindows).
  if (BaseWindow.getFocusedWindow()) {
    window.showInactive()
    return
  }
  if (windowsAwaitingAppActive.size === 0) {
    // macOS reports the app's return through any window; elsewhere BrowserWindows and origin-bar popups report focus.
    electronApp.on('browser-window-focus', revealWindowsAwaitingAppActive)
    electronApp.on('did-become-active', revealWindowsAwaitingAppActive)
  }
  windowsAwaitingAppActive.add(window)
  window.once('closed', () => {
    if (windowsAwaitingAppActive.delete(window) && windowsAwaitingAppActive.size === 0) {
      stopAwaitingAppActive()
    }
  })
}
