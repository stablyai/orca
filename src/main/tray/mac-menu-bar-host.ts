import { app } from 'electron'
import { cachedRolloutConfig, resolveRolloutFlag } from '../updater/rollout/rollout-flags'

/** Which process owns the macOS menu-bar item; null while none is shown. */
export type MenuBarHost = 'helper' | 'in-process' | 'in-process-fallback' | 'helper-gave-up'
/** Who owns the icon for this launch; 'off' after started helpers kept failing. */
export type LaunchMenuBarHost = 'helper' | 'in-process' | 'off'

let listener: ((host: MenuBarHost | null) => void) | null = null
let current: MenuBarHost | null = null

// Hang captures tag this so the AppKit scene deadlock group can be split by host.
export function setMenuBarHostListener(next: ((host: MenuBarHost | null) => void) | null): void {
  listener = next
  next?.(current)
}

export function reportMenuBarHost(host: MenuBarHost | null): void {
  if (host === current) {
    return
  }
  current = host
  listener?.(host)
}

let launchHost: LaunchMenuBarHost | null = null

/** Decided once per launch from the last saved rollout block, so a hide/show keeps the same owner. */
export function launchMacMenuBarHost(installId: string | null): LaunchMenuBarHost {
  launchHost ??= resolveRolloutFlag('mac-menu-bar-helper', {
    config: cachedRolloutConfig(),
    appVersion: app.getVersion(),
    installId
  })
    ? 'helper'
    : 'in-process'
  return launchHost
}

/** After the helper failed this launch, later hide/show cycles use the in-process icon at once. */
let fellBack = false

/** The in-process icon's telemetry label: fallback icons stay distinguishable across hide/show. */
export function inProcessMenuBarHost(): MenuBarHost {
  return fellBack ? 'in-process-fallback' : 'in-process'
}

export function markMacMenuBarHelperUnavailable(next: 'in-process' | 'off'): void {
  fellBack = next === 'in-process'
  launchHost = next
  if (next === 'off') {
    reportMenuBarHost('helper-gave-up')
  }
}

// The startup `tray-created` milestone fires once, whichever caller created the icon first.
let iconShown = false
let pendingOnCreated: (() => void) | undefined

export function awaitMacIconShown(onCreated: (() => void) | undefined): void {
  if (onCreated && iconShown) {
    onCreated()
  } else if (onCreated) {
    pendingOnCreated = onCreated
  }
}

export function markMacIconShown(shown: boolean): void {
  iconShown = shown
  if (shown) {
    const callback = pendingOnCreated
    pendingOnCreated = undefined
    callback?.()
  }
}
