import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  getMobileTerminalThemeSelection,
  loadMobileTerminalThemeSelection,
  subscribeMobileTerminalThemeSelection
} from '../storage/terminal-theme-preference'
import { useTheme } from '../theme/theme-context'
import { selectMobileTerminalTheme } from './terminal-theme-slot-selection'
import type { MobileTerminalTheme } from './terminal-webview-contract'

/** Applies the device-local slot choice on top of the host-pushed palette. */
export function useMobileTerminalTheme(
  hostTheme: MobileTerminalTheme | undefined
): MobileTerminalTheme | undefined {
  const { mode } = useTheme()
  const selection = useSyncExternalStore(
    subscribeMobileTerminalThemeSelection,
    getMobileTerminalThemeSelection
  )
  useEffect(() => {
    void loadMobileTerminalThemeSelection()
  }, [])
  return useMemo(
    () => selectMobileTerminalTheme(selection, mode, hostTheme),
    [hostTheme, mode, selection]
  )
}
