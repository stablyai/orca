import { structuredSessionIdFromNotificationPane } from '../../../src/shared/structured-session-notification-pane'
import type { StructuredSessionOpenSource } from '../../../src/shared/open-structured-agent-session'
import { useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'

// The document at / receives pane requests through shell init. A host-area page also names the pane
// on its own route, which never reaches that init.
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
  const { setParams } = useRouter()
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams
  const localPaneKey = firstParam(useLocalSearchParams<{ paneKey?: string | string[] }>().paneKey)
  // The opening tap arrives only in the initial init, before route-update listeners.
  const opened = client.getShellSession()?.route?.params?.paneKey ?? null
  const pending = useRef(opened !== null && opened !== '' ? opened : localPaneKey || null)
  const applied = useRef<string | null>(null)
  const sawLocalPane = useRef(false)
  // Shell init and the document route can both carry the opening pane. Apply the shell one once.
  // A different document pane is its own request and must not be cleared in favor of the shell pane.
  const suppressInitialLocal = useRef(
    (opened ?? '') !== '' && localPaneKey !== '' && opened === localPaneKey
  )
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
    if (suppressInitialLocal.current) {
      suppressInitialLocal.current = false
      if (localPaneKey !== '') {
        setParamsRef.current({ paneKey: '' })
      }
      return
    }
    if (localPaneKey === '') {
      // Clearing the document param is what makes the next tap of the same session a new request.
      if (sawLocalPane.current) {
        applied.current = null
        sawLocalPane.current = false
      }
      return
    }
    sawLocalPane.current = true
    setParamsRef.current({ paneKey: '' })
    if (localPaneKey === applied.current) {
      return
    }
    pending.current = localPaneKey
    setAsked((count) => count + 1)
  }, [localPaneKey])

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
