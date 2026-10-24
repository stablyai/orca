import { app as electronApp, type BrowserWindow } from 'electron'

/**
 * Foreground policy for automated launches (E2E, benchmarks, agent-driven dev
 * validation). These runs may use the machine, but must never take the OS
 * foreground away from whatever the developer is doing.
 *
 * ORCA_BACKGROUND_LAUNCH=1 keeps automation off screen. Native-focus specs
 * can use ORCA_E2E_FOREGROUND=1 only without an explicit background request.
 * The hosted-Xvfb terminal benchmark explicitly presents after startup; see tests/AGENTS.md.
 * This policy still suppresses its automatic reveals and foreground activation.
 * orcad's browser sidecar (ORCA_ORCAD_SIDECAR=1) is held to the same explicit request.
 */

type ActivationPolicyApp = {
  dock?: { hide: () => void; show: () => void }
  setActivationPolicy: (policy: 'accessory' | 'prohibited' | 'regular') => void
}

/** Reads ORCA_BACKGROUND_LAUNCH, ORCA_ORCAD_SIDECAR, ORCA_E2E_FOREGROUND, ORCA_E2E_HEADLESS, ORCA_E2E_HEADFUL. */
type PolicyEnv = Readonly<Record<string, string | undefined>>

/**
 * A background process stays hidden until the user asks for it (a later desktop
 * launch or the tray). The flag clears that latch for this process only.
 */
let userForegroundAccepted = false

/** Lets this process show and take focus after an explicit user request. */
export function acceptUserForegroundRequest(
  options: {
    app?: ActivationPolicyApp
    env?: PolicyEnv
    platform?: NodeJS.Platform
    warn?: (message: string, error: unknown) => void
  } = {}
): void {
  if (userForegroundAccepted) {
    return
  }
  // Read this before the latch flips, or a windowless macOS process looks normal and keeps its Dock hidden.
  const restoreMacPolicy =
    (options.platform ?? process.platform) === 'darwin' &&
    isWindowlessLaunch(options.env ?? process.env)
  userForegroundAccepted = true
  if (!restoreMacPolicy) {
    return
  }
  try {
    const app = options.app ?? electronApp
    app.setActivationPolicy('regular')
    void app.dock?.show()
  } catch (error) {
    options.warn?.('[window] Failed to restore regular activation policy', error)
  }
}

/** Test isolation: the latch is process-global. */
export function resetAcceptedUserForegroundForTests(): void {
  userForegroundAccepted = false
}

function userForegroundOverrides(env: PolicyEnv): boolean {
  return userForegroundAccepted && env === process.env
}

/** orcad's headless browser provider: a serve process on a throwaway profile that no user drives. */
export function isOrcadSidecarLaunch(env: PolicyEnv = process.env): boolean {
  return env.ORCA_ORCAD_SIDECAR === '1'
}

function isExplicitBackgroundLaunch(env: PolicyEnv): boolean {
  return env.ORCA_BACKGROUND_LAUNCH === '1' || isOrcadSidecarLaunch(env)
}

/** True when this process must not steal focus, raise windows, or activate the app. */
export function isBackgroundLaunch(env: PolicyEnv = process.env): boolean {
  if (userForegroundOverrides(env)) {
    return false
  }
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
  if (userForegroundOverrides(env)) {
    return false
  }
  return (
    isExplicitBackgroundLaunch(env) ||
    (isBackgroundLaunch(env) && env.ORCA_E2E_HEADLESS === '1' && env.ORCA_E2E_HEADFUL !== '1')
  )
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
