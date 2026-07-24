import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  getMobileTerminalThemeSelection,
  loadMobileTerminalThemeSelection,
  subscribeMobileTerminalThemeSelection
} from '../storage/terminal-theme-preference'
import { selectMobileTerminalTheme } from './terminal-theme-slot-selection'
import type { MobileTerminalTheme } from './terminal-webview-contract'

// Why the literal: mobile chrome is dark-only on this branch, so this IS the app mode.
const APP_MODE = 'dark'

/** Applies the device-local slot choice on top of the host-pushed palette. */
export function useMobileTerminalTheme(
  hostTheme: MobileTerminalTheme | undefined
): MobileTerminalTheme | undefined {
  const selection = useSyncExternalStore(
    subscribeMobileTerminalThemeSelection,
    getMobileTerminalThemeSelection
  )
  useEffect(() => {
    void loadMobileTerminalThemeSelection()
  }, [])
  return useMemo(
    () => selectMobileTerminalTheme(selection, APP_MODE, hostTheme),
    [hostTheme, selection]
  )
}
