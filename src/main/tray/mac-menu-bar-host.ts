import { app } from 'electron'
import { cachedRolloutConfig, resolveRolloutFlag } from '../updater/rollout/rollout-flags'

/** Which process owns the macOS menu-bar item; null while none is shown. */
export type MenuBarHost = 'helper' | 'in-process'

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

let launchHost: MenuBarHost | null = null

/** Decided once per launch from the last saved rollout block, so a hide/show keeps the same owner. */
export function launchMacMenuBarHost(installId: string | null): MenuBarHost {
  launchHost ??= resolveRolloutFlag('mac-menu-bar-helper', {
    config: cachedRolloutConfig(),
    appVersion: app.getVersion(),
    installId
  })
    ? 'helper'
    : 'in-process'
  return launchHost
}
