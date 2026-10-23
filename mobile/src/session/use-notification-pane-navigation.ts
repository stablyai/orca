import { useEffect, useRef, useState } from 'react'
import { decodeInPageNotificationTarget } from '../notifications/in-page-notification-navigation'
import type { RouteHandoff } from '../navigation/route-handoff'
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

export function useNotificationPaneNavigation({
  hostId,
  worktreeId,
  router,
  sessionTabs,
  terminalsLoaded,
  switchSessionTab
}: {
  hostId?: string
  worktreeId?: string
  router?: Pick<RouteHandoff, 'replace'>
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  switchSessionTab: (tab: MobileSessionTab) => void
}) {
  const client = usePageBridgeClient()
  // Seeded from the route this page was opened on: a tap that opened the session arrives in the
  // first `init` and never as an update, so a hook that only listened would lose it.
  const opened = client.getShellSession()?.route?.params?.paneKey ?? null
  const pending = useRef<PendingNotificationRequest | null>(toPendingSeed(opened))
  /** The pane this hook last acted on, so one request is not served twice. Cleared by the erase. */
  const applied = useRef<string | null>(null)
  const [asked, setAsked] = useState(0)
  const latestContextRef = useRef({ hostId, worktreeId, router })
  useEffect(() => {
    latestContextRef.current = { hostId, worktreeId, router }
  })

  useEffect(() => {
    // The route this page opened on is erased once, here: it arrived in the first `init`, which
    // is not an update, so nothing below would ever name it back. Read from the client rather
    // than from the render above, which keeps this effect keyed on the client alone.
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
        current.router.replace(
          workspaceRouteHref(
            `/h/${encodeURIComponent(current.hostId)}/session/${encodeURIComponent(decoded.worktreeId)}`,
            routeExecutionHostOf(decoded.executionHost)
          )
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
    // Consumed even when the pane has since closed: a request left standing is one a later render
    // would serve.
    pending.current = null
    applied.current = request.raw
    const tab = notificationPaneTab(sessionTabs, request.paneKey)
    if (tab) {
      switchSessionTab(tab)
    }
  }, [asked, sessionTabs, switchSessionTab, terminalsLoaded, worktreeId])
}
