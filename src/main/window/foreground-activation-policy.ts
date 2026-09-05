import { app as electronApp, type BrowserWindow } from 'electron'

/**
 * Foreground policy for automated launches (E2E, benchmarks, agent-driven dev
 * validation). These runs may use the machine, but must never take the OS
 * foreground away from whatever the developer is doing.
 *
 * ORCA_BACKGROUND_LAUNCH=1 opts a normal launch in; ORCA_E2E_FOREGROUND=1 opts
 * back out for the few specs whose subject *is* native focus (IME, key events).
 */

type ActivationPolicyApp = {
  dock?: { hide: () => void }
  setActivationPolicy: (policy: 'accessory' | 'prohibited' | 'regular') => void
}

/** Reads ORCA_BACKGROUND_LAUNCH, ORCA_E2E_FOREGROUND, ORCA_E2E_HEADLESS, ORCA_E2E_HEADFUL. */
type PolicyEnv = Readonly<Record<string, string | undefined>>

/** True when this process must not steal focus, raise windows, or activate the app. */
export function isBackgroundLaunch(env: PolicyEnv = process.env): boolean {
  if (env.ORCA_E2E_FOREGROUND === '1') {
    return false
  }
  return (
    env.ORCA_BACKGROUND_LAUNCH === '1' ||
    env.ORCA_E2E_HEADLESS === '1' ||
    env.ORCA_E2E_HEADFUL === '1'
  )
}

/** True when no window should reach the screen at all (headless E2E; Playwright drives via CDP). */
export function isWindowlessLaunch(env: PolicyEnv = process.env): boolean {
  return isBackgroundLaunch(env) && env.ORCA_E2E_HEADLESS === '1' && env.ORCA_E2E_HEADFUL !== '1'
}

/**
 * macOS: a windowless run still claims a Dock tile and the menu bar as it starts
 * and exits. `accessory` drops both while leaving programmatic activation intact.
 */
export function applyBackgroundActivationPolicy(
  options: {
    app?: ActivationPolicyApp
    env?: PolicyEnv
    platform?: NodeJS.Platform
    warn?: (message: string, error: unknown) => void
  } = {}
): boolean {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' || !isWindowlessLaunch(options.env ?? process.env)) {
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

/**
 * Reveal a window without taking the foreground: hidden entirely when windowless,
 * `showInactive()` (visible, not raised over the active app) in background launches.
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
