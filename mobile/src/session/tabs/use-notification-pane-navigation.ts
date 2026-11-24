import { structuredSessionIdFromNotificationPane } from '../../../../src/shared/agent-session/view/structured-session-notification-pane'
import type { StructuredSessionOpenSource } from '../../../../src/shared/agent-session/view/open-structured-agent-session'
import { useEffect, useRef } from 'react'
import { useSessionRouteRequest } from '../use-session-route-request'
import type { MobileSessionTab } from './mobile-session-tabs'
import { notificationPaneTab } from './notification-pane-tab'

// The document at / receives pane requests through shell init, except the opening tap of a session reached by an in-page hop.
// Erase every arrival to repair lost clears, but switch once per value so replay cannot undo a later tab pick.
// Retain the request until terminal inventory arrives.
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
  const request = useSessionRouteRequest('paneKey')
  const applied = useRef<typeof request>(null)

  useEffect(() => {
    const paneKey = request?.value
    if (!request || applied.current === request) {
      return
    }
    if (!paneKey || !terminalsLoaded) {
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
    // A pre-reconnect inventory can predate the pane named by the push.
    if (tab) {
      applied.current = request
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
        applied.current = request
        void openNativeSession({ kind: 'notification', sessionId, worktreeId })
      }
    }
  }, [
    request,
    connState,
    sessionTabs,
    switchSessionTab,
    terminalsLoaded,
    worktreeId,
    openNativeSession
  ])
}
