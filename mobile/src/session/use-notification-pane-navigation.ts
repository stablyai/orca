import { useEffect } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { notificationPaneTab } from './notification-pane-tab'
import type { MobileSessionTab } from './mobile-session-route-types'

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
  const router = useRouteHandoff()
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
