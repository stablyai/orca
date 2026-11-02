import { structuredSessionIdFromNotificationPane } from '../../../src/shared/structured-session-notification-pane'
import type { StructuredSessionOpenSource } from '../../../src/shared/open-structured-agent-session'
import { useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { decodeInPageNotificationTarget } from '../notifications/in-page-notification-navigation'
import type { RouteHandoff } from '../navigation/route-handoff'
import { firstParam } from '../navigation/route-param-reader'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { usePageBridgeClient } from '../transport/client-context.web'
import { routeExecutionHostOf } from '../worktree/host-list-highlight'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'

type PendingNotificationRequest = {
  raw: string
  paneKey: string
  worktreeId: string | null
  crossWorktree: boolean
  sawTargetWorktreeReset: boolean
}

function toPendingSeed(opened: string | null): PendingNotificationRequest | null {
  if (!opened) {
    return null
  }
  const decoded = decodeInPageNotificationTarget(opened)
  if (!decoded.paneKey) {
    return null
  }
  return {
    raw: opened,
    paneKey: decoded.paneKey,
    worktreeId: decoded.worktreeId ?? null,
    crossWorktree: false,
    sawTargetWorktreeReset: false
  }
}

// The document at / receives pane requests through shell init, except the opening tap of a session reached by an in-page hop.
// Erase every arrival to repair lost clears, but switch once per value so replay cannot undo a later tab pick.
// Keep pending requests in a ref until terminal inventory arrives, avoiding a stale selection render.
export function useNotificationPaneNavigation({
  hostId,
  worktreeId,
  router,
  sessionTabs,
  terminalsLoaded,
  connState,
  switchSessionTab,
  openNativeSession
}: {
  hostId?: string
  worktreeId?: string
  router?: Pick<RouteHandoff, 'replace'>
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  connState?: string
  switchSessionTab: (tab: MobileSessionTab) => void
  openNativeSession?: (source: StructuredSessionOpenSource) => Promise<void>
}) {
  const client = usePageBridgeClient()
  // Page URL taps are cleared here; cross-workspace hops use the handoff router argument.
  const pageRouter = useRouter()
  // An in-page hop (an agent row, a sender jump) carries the tap only in the page URL; the shell route never names it.
  const urlPaneKey =
    firstParam(useLocalSearchParams<{ paneKey?: string | string[] }>().paneKey) || null
  // The shell's pane wins: the URL copied it at bootstrap and can be older than a later notification tap.
  // The opening tap arrives only in the initial init, before route-update listeners.
  const opened = client.getShellSession()?.route?.params?.paneKey || urlPaneKey || null
  const pending = useRef<PendingNotificationRequest | null>(toPendingSeed(opened))
  /** The pane this hook last acted on, so one request is not served twice. Cleared by the erase. */
  const applied = useRef<string | null>(null)
  const [asked, setAsked] = useState(0)
  const latestContextRef = useRef({ hostId, worktreeId, router })
  useEffect(() => {
    latestContextRef.current = { hostId, worktreeId, router }
  })

  useEffect(() => {
    // Spend the URL's tap so a remount of this screen cannot replay it over a later tab pick.
    if (urlPaneKey !== null) {
      pageRouter.setParams({ paneKey: undefined })
    }
  }, [pageRouter, urlPaneKey])

  useEffect(() => {
    // Acknowledge the initial init separately; read from the client to keep the effect keyed only on client.
    const seed = client.getShellSession()?.route?.params?.paneKey ?? null
    if (seed !== null && seed !== '') {
      client.clearRouteParam('paneKey', seed)
    }
    return client.onRouteUpdate((route) => {
      const rawParam = route?.params?.paneKey ?? ''
      if (rawParam === '') {
        // The shell's own erase, and every `ready` answered after it. Not a request, and what
        // releases the next tap for the pane this one named.
        applied.current = null
        return
      }
      // Asked for on arrival rather than on the switch below: the shell holds the request until
      // it hears, so a clear that was lost has to be re-asked by the frame that repeats it.
      client.clearRouteParam('paneKey', rawParam)
      if (rawParam === applied.current) {
        return
      }
      const decoded = decodeInPageNotificationTarget(rawParam)
      const current = latestContextRef.current
      if (
        decoded.worktreeId &&
        current.worktreeId &&
        decoded.worktreeId !== current.worktreeId &&
        current.hostId &&
        current.router
      ) {
        applied.current = rawParam
        pending.current = decoded.paneKey
          ? {
              raw: rawParam,
              paneKey: decoded.paneKey,
              worktreeId: decoded.worktreeId,
              crossWorktree: true,
              sawTargetWorktreeReset: false
            }
          : null
        const href = workspaceRouteHref(
          `/h/${encodeURIComponent(current.hostId)}/session/${encodeURIComponent(decoded.worktreeId)}`,
          routeExecutionHostOf(decoded.executionHost)
        )
        current.router.replace(
          decoded.paneKey
            ? `${href}${href.includes('?') ? '&' : '?'}paneKey=${encodeURIComponent(decoded.paneKey)}`
            : href
        )
        if (decoded.paneKey) {
          setAsked((count) => count + 1)
        }
        return
      }
      if (!decoded.paneKey) {
        return
      }
      pending.current = {
        raw: rawParam,
        paneKey: decoded.paneKey,
        worktreeId: decoded.worktreeId ?? current.worktreeId ?? null,
        crossWorktree: false,
        sawTargetWorktreeReset: false
      }
      setAsked((count) => count + 1)
    })
  }, [client])

  useEffect(() => {
    const request = pending.current
    if (request === null) {
      return
    }
    if (request.worktreeId && worktreeId && request.worktreeId !== worktreeId) {
      return
    }
    if (request.crossWorktree) {
      if (sessionTabs.length === 0) {
        request.sawTargetWorktreeReset = true
        return
      }
      if (!request.sawTargetWorktreeReset) {
        return
      }
    }
    if (!terminalsLoaded) {
      return
    }
    const paneKey = request.paneKey
    const tab = notificationPaneTab(sessionTabs, paneKey)
    if (
      openNativeSession &&
      connState !== undefined &&
      connState !== 'connected' &&
      (tab?.type === 'agent-session' || structuredSessionIdFromNotificationPane(paneKey))
    ) {
      return
    }
    applied.current = request.raw
    // Held while missing: a list loaded before a reconnect can predate the agent the push names.
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
