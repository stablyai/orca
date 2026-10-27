import { useEffect, useRef, useState } from 'react'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'

// The document at / receives pane requests through shell init; router params belong to the native shell.
// Erase every arrival to repair lost clears, but switch once per value so replay cannot undo a later tab pick.
// Keep pending requests in a ref until terminal inventory arrives, avoiding a stale selection render.
export function useNotificationPaneNavigation({
  sessionTabs,
  terminalsLoaded,
  switchSessionTab
}: {
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  switchSessionTab: (tab: MobileSessionTab) => void
}) {
  const client = usePageBridgeClient()
  // The opening tap arrives only in the initial init, before route-update listeners.
  const opened = client.getShellSession()?.route?.params?.paneKey ?? null
  const pending = useRef(opened)
  const applied = useRef<string | null>(null)
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    // Acknowledge the initial init separately; read from the client to keep the effect keyed only on client.
    const seed = client.getShellSession()?.route?.params?.paneKey ?? null
    if (seed !== null && seed !== '') {
      client.clearRouteParam('paneKey', seed)
    }
    return client.onRouteUpdate((route) => {
      const paneKey = route?.params?.paneKey ?? ''
      if (paneKey === '') {
        // An erased route permits a later tap for the same pane.
        applied.current = null
        return
      }
      // Retry clear on every arrival so a lost acknowledgement is repaired even when switching is deduped.
      client.clearRouteParam('paneKey', paneKey)
      if (paneKey === applied.current) {
        return
      }
      pending.current = paneKey
      setAsked((count) => count + 1)
    })
  }, [client])

  useEffect(() => {
    const paneKey = pending.current
    if (paneKey === null || paneKey === '' || !terminalsLoaded) {
      return
    }
    applied.current = paneKey
    const tab = notificationPaneTab(sessionTabs, paneKey)
    // A pre-reconnect inventory can predate the pane named by the push.
    if (tab) {
      pending.current = null
      switchSessionTab(tab)
    }
  }, [asked, sessionTabs, switchSessionTab, terminalsLoaded])
}
