import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'
import type { MobileTerminalThemeSelection } from '../storage/terminal-theme-preference'
import type { MobileTerminalTheme } from './terminal-webview-contract'

// Why literals: named exports live in terminal-theme-resolution (PR3). Until that
// lands, pin the same desktop default names from src/shared/constants.ts:219,222.
const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'

/**
 * Device slot choice wins over the host-pushed palette; a null or uncatalogued
 * slot follows the host, so a phone that never picked a theme is unaffected.
 */
export function selectMobileTerminalTheme(
  selection: MobileTerminalThemeSelection,
  appMode: 'dark' | 'light',
  hostTheme: MobileTerminalTheme | undefined
): MobileTerminalTheme | undefined {
  // Mirrors src/renderer/src/lib/terminal-theme.ts:129-132, asymmetry included:
  // light mode without a separate light theme uses the dark slot, still reporting light.
  const useLightSlot = appMode === 'light' && selection.useSeparateLightTheme
  const name = useLightSlot ? selection.light : selection.dark
  if (name === null) {
    // Why: the host resolves its palette against the DESKTOP's mode. If that mode is not
    // ours, using it would put a dark terminal in a light app — the exact outcome the
    // two-slot model exists to prevent. Fall back to the desktop default for OUR mode.
    if (!hostTheme || hostTheme.mode === appMode) {
      return hostTheme
    }
    const fallback = getBuiltinTerminalThemePalette(
      appMode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
    )
    return fallback ? { mode: appMode, theme: fallback } : hostTheme
  }
  const palette = getBuiltinTerminalThemePalette(name)
  return palette ? { mode: appMode, theme: palette } : hostTheme
}
