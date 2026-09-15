import { useEffect } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { MobileSessionTab } from './mobile-session-route-types'

export function notificationPaneTab(tabs: readonly MobileSessionTab[], paneKey: string) {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) =>
    tab.type === 'terminal'
      ? (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
      : tab.type === 'agent-session' && tab.id === pane.tabId
  )
}

export function useNotificationPaneNavigation({
  sessionTabs,
  terminalsLoaded,
  switchSessionTab
}: {
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  switchSessionTab: (tab: MobileSessionTab) => void
}) {
  const { paneKey } = useLocalSearchParams<{ paneKey?: string }>()
  const router = useRouter()
  useEffect(() => {
    if (!terminalsLoaded || typeof paneKey !== 'string' || !paneKey) {
      return
    }
    const tab = notificationPaneTab(sessionTabs, paneKey)
    // Consume the tap even if the pane was closed; later snapshots must not steal selection.
    router.setParams({ paneKey: '' })
    if (tab) {
      switchSessionTab(tab)
    }
  }, [paneKey, terminalsLoaded, sessionTabs, switchSessionTab, router])
}
