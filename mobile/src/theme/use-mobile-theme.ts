import { useSyncExternalStore } from 'react'
import { getMobileColorScheme, subscribeMobileTheme } from './mobile-theme'

/** Updates themed views without replacing their component or navigation state. */
export function useMobileTheme() {
  return useSyncExternalStore(subscribeMobileTheme, getMobileColorScheme, getMobileColorScheme)
}
