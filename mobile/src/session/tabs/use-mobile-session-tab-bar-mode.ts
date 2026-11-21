import { useEffect, useSyncExternalStore } from 'react'
import {
  getMobileSessionTabBarModeSync,
  getMobileSessionTabsSheetScopeSync,
  hydrateRecentSessionCards,
  setMobileSessionTabBarMode,
  setMobileSessionTabsSheetScope,
  subscribeRecentSessionCards,
  type MobileSessionTabBarMode,
  type MobileSessionTabsSheetScope
} from '../recent-session-cards'

/** Subscribes to the mobile session tab bar mode ('classic-strip' vs 'single-tab'). */
export function useMobileSessionTabBarMode(): {
  mode: MobileSessionTabBarMode
  setMode: (mode: MobileSessionTabBarMode) => MobileSessionTabBarMode
  toggleMode: () => MobileSessionTabBarMode
} {
  const mode = useSyncExternalStore(
    subscribeRecentSessionCards,
    getMobileSessionTabBarModeSync,
    getMobileSessionTabBarModeSync
  )
  useEffect(() => {
    void hydrateRecentSessionCards().catch(() => {})
  }, [])
  return {
    mode,
    setMode: setMobileSessionTabBarMode,
    toggleMode: () =>
      setMobileSessionTabBarMode(mode === 'classic-strip' ? 'single-tab' : 'classic-strip')
  }
}

/** Subscribes to the sticky tabs-sheet scope preference ('recent' vs 'workspace'). */
export function useMobileSessionTabsSheetScope(): {
  scope: MobileSessionTabsSheetScope
  setScope: (scope: MobileSessionTabsSheetScope) => MobileSessionTabsSheetScope
} {
  const scope = useSyncExternalStore(
    subscribeRecentSessionCards,
    getMobileSessionTabsSheetScopeSync,
    getMobileSessionTabsSheetScopeSync
  )
  useEffect(() => {
    void hydrateRecentSessionCards().catch(() => {})
  }, [])
  return {
    scope,
    setScope: setMobileSessionTabsSheetScope
  }
}
