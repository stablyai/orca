import { useEffect, useSyncExternalStore } from 'react'
import { useColorScheme } from 'react-native'
import { DEFAULT_TERMINAL_THEMES } from '../../../src/shared/terminal-default-themes'
import {
  getMobileTerminalThemeMode,
  loadMobileTerminalThemeMode,
  subscribeMobileTerminalThemeMode
} from '../storage/terminal-theme-preference'
import type { MobileTerminalTheme } from './terminal-webview-contract'

const LOCAL_TERMINAL_THEMES: Record<'dark' | 'light', MobileTerminalTheme> = {
  dark: { mode: 'dark', theme: DEFAULT_TERMINAL_THEMES['Ghostty Default Style Dark'] },
  light: { mode: 'light', theme: DEFAULT_TERMINAL_THEMES['Builtin Tango Light'] }
}

export function useMobileTerminalTheme(
  hostTheme: MobileTerminalTheme | undefined
): MobileTerminalTheme | undefined {
  const mode = useSyncExternalStore(
    subscribeMobileTerminalThemeMode,
    getMobileTerminalThemeMode,
    getMobileTerminalThemeMode
  )
  const systemScheme = useColorScheme()
  useEffect(() => {
    void loadMobileTerminalThemeMode().catch((error) => {
      console.warn('Failed to load terminal appearance preference', error)
    })
  }, [])
  if (mode === 'desktop') {
    return hostTheme
  }
  // Unknown native appearance keeps the app's existing dark default.
  const localMode = mode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : mode
  return LOCAL_TERMINAL_THEMES[localMode]
}
