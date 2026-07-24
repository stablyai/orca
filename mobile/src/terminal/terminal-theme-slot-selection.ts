import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'
import type { MobileTerminalThemeSelection } from '../storage/terminal-theme-preference'
import type { MobileTerminalTheme } from './terminal-webview-contract'

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
  const palette = name ? getBuiltinTerminalThemePalette(name) : null
  return palette ? { mode: appMode, theme: palette } : hostTheme
}
