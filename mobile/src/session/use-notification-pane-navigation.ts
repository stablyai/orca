import { structuredSessionIdFromNotificationPane } from '../../../src/shared/structured-session-notification-pane'
import type { StructuredSessionOpenSource } from '../../../src/shared/open-structured-agent-session'
import { useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'

// The document at / receives pane requests through shell init, except the opening tap of a session reached by an in-page hop.
// Erase every arrival to repair lost clears, but switch once per value so replay cannot undo a later tab pick.
// Keep pending requests in a ref until terminal inventory arrives, avoiding a stale selection render.
export function useNotificationPaneNavigation({
  sessionTabs,
  terminalsLoaded,
  connState,
  switchSessionTab,
  worktreeId,
  openNativeSession
}: {
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  connState?: string
  switchSessionTab: (tab: MobileSessionTab) => void
  worktreeId?: string
  openNativeSession?: (source: StructuredSessionOpenSource) => Promise<void>
}) {
  const client = usePageBridgeClient()
  const router = useRouter()
  // An in-page hop (an agent row, a sender jump) carries the tap only in the page URL; the shell route never names it.
  const urlPaneKey =
    firstParam(useLocalSearchParams<{ paneKey?: string | string[] }>().paneKey) || null
  // The shell's pane wins: the URL copied it at bootstrap and can be older than a later notification tap.
  const pending = useRef(client.getShellSession()?.route?.params?.paneKey || urlPaneKey)
  const applied = useRef<string | null>(null)
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    // Spend the URL's tap so a remount of this screen cannot replay it over a later tab pick.
    if (urlPaneKey !== null) {
      router.setParams({ paneKey: undefined })
    }
  }, [router, urlPaneKey])

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
    const tab = notificationPaneTab(sessionTabs, paneKey)
    if (
      openNativeSession &&
      connState !== undefined &&
      connState !== 'connected' &&
      (tab?.type === 'agent-session' || structuredSessionIdFromNotificationPane(paneKey))
    ) {
      return
    }
    applied.current = paneKey
    // A pre-reconnect inventory can predate the pane named by the push.
    if (tab) {
      pending.current = null
      if (tab.type === 'agent-session' && openNativeSession && worktreeId) {
        void openNativeSession({
          kind: 'notification',
          sessionId: tab.sessionId,
          worktreeId,
          agent: tab.agent
        })
      } else {
        switchSessionTab(tab)
      }
    } else if (openNativeSession && worktreeId) {
      const sessionId = structuredSessionIdFromNotificationPane(paneKey)
      if (sessionId) {
        pending.current = null
        void openNativeSession({ kind: 'notification', sessionId, worktreeId })
      }
    }
  }, [
    asked,
    connState,
    sessionTabs,
    switchSessionTab,
    terminalsLoaded,
    worktreeId,
    openNativeSession
  ])
}
