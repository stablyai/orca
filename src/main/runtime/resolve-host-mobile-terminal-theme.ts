import {
  resolveRuntimeMobileTerminalTheme,
  type RuntimeMobileTerminalThemeSettings
} from '../../shared/runtime-mobile-terminal-theme'
import type { RuntimeMobileTerminalTheme } from '../../shared/runtime-types'

// Why dark-biased: main has no matchMedia, so a headless host mirrors the renderer's
// no-matchMedia fallback (getSystemPrefersDark). An attached host can reach this too,
// where a light 'system' preference reads as dark — still strictly better than the
// phone's hardcoded fallback, which is what it replaces.
export function resolveHostMobileTerminalTheme(
  settings: RuntimeMobileTerminalThemeSettings | null | undefined
): RuntimeMobileTerminalTheme | undefined {
  return resolveRuntimeMobileTerminalTheme(settings, true)
}
