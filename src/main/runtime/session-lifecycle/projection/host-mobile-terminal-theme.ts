import type { RuntimeMobileTerminalTheme } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  resolveMobileTerminalTheme,
  type MobileTerminalThemeSettings
} from '../../../../shared/terminal-themes/mobile-terminal-theme'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

// The store contract names only what the runtime reads; the real store holds every setting.
type RuntimeSettings = ReturnType<RuntimeStore['getSettings']>

function hasTerminalPalette(
  settings: RuntimeSettings | undefined
): settings is RuntimeSettings & MobileTerminalThemeSettings {
  return (
    settings !== undefined &&
    'theme' in settings &&
    typeof settings.theme === 'string' &&
    'terminalThemeDark' in settings &&
    typeof settings.terminalThemeDark === 'string' &&
    'terminalThemeLight' in settings &&
    typeof settings.terminalThemeLight === 'string' &&
    'terminalUseSeparateLightTheme' in settings &&
    typeof settings.terminalUseSeparateLightTheme === 'boolean'
  )
}

/** The phone palette from this host's saved settings, for terminal rows no window themed.
 *  `system` reads as dark, as this host's OSC 10/11 replies do when no window answers.
 *  Phones keep the palette of the last frame, so a palette change re-sends the rows. */
export function hostMobileTerminalTheme(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null,
  onChanged: () => void
): () => RuntimeMobileTerminalTheme | undefined {
  let cachedSettings: unknown
  let cached: RuntimeMobileTerminalTheme | undefined
  const read = (): RuntimeMobileTerminalTheme | undefined => {
    const settings = store?.getSettings?.()
    if (settings !== cachedSettings) {
      cachedSettings = settings
      cached = hasTerminalPalette(settings) ? resolveMobileTerminalTheme(settings, true) : undefined
    }
    return cached
  }
  let published = JSON.stringify(read() ?? null)
  store?.onSettingsChanged?.(() => {
    const next = JSON.stringify(read() ?? null)
    if (next !== published) {
      published = next
      onChanged()
    }
  })
  return read
}

/** True when at least one terminal row in the snapshot falls back to the host's own palette. */
export function snapshotUsesHostMobileTerminalTheme(
  snapshot: RuntimeMobileSessionTabsSnapshot
): boolean {
  return snapshot.tabs.some((tab) => tab.type === 'terminal' && !tab.terminalTheme)
}

/** Re-send only workspaces with an unthemed terminal row, skipping listeners-empty hosts and workspace activity rescans. */
export function notifyHostMobileTerminalThemeSnapshots(
  hasListeners: boolean,
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>,
  createDelivery: () => (result: RuntimeMobileSessionTabsResult, sequence: number) => void,
  project: (snapshot: RuntimeMobileSessionTabsSnapshot) => RuntimeMobileSessionTabsResult,
  nextSequence: () => number
): void {
  if (!hasListeners) {
    return
  }
  let deliver: ((result: RuntimeMobileSessionTabsResult, sequence: number) => void) | null = null
  for (const snapshot of snapshots) {
    if (snapshotUsesHostMobileTerminalTheme(snapshot)) {
      deliver ??= createDelivery()
      deliver(project(snapshot), nextSequence())
    }
  }
}
