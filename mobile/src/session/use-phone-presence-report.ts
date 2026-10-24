import { useCallback, useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

/** The session routes one host's client has in focus, by screen. */
type HostView = { focused: Map<object, string>; holders: number; stopAppState: () => void }

// One per client: every session screen on a host reports into one view, so a screen's blur and
// another's focus cannot overwrite each other in either order.
const viewsByClient = new Map<RpcClient, HostView>()

/**
 * What the phone shows a host: the session routes in focus while the app is in the foreground (0
 * away otherwise). Naming them tells a current host that a session route left behind another
 * screen is not on screen; an older one reads only the presence.
 */
export function phonePresenceView(
  state: AppStateStatus,
  focused: Iterable<string>
): { workspaceIds: string[]; tabIds: string[]; presentForMs: number | null } {
  const workspaceIds = state === 'active' ? [...new Set(focused)] : []
  return { workspaceIds, tabIds: [], presentForMs: workspaceIds.length > 0 ? null : 0 }
}

function report(client: RpcClient, view: HostView): void {
  const params = phonePresenceView(AppState.currentState, view.focused.values())
  // The transport says it first on every new session, before replaying any subscription, so the
  // host never reads a covered route's re-subscribe as one on screen. An older or switch-off host
  // refuses the method; it then holds the session until close as before.
  if (client.setSessionPreamble) {
    client.setSessionPreamble('sidebarInputs.reportView', 'sidebarInputs.reportView', params)
  } else {
    void client.sendRequest('sidebarInputs.reportView', params).catch(() => {})
  }
}

function holdHostView(client: RpcClient): HostView {
  const existing = viewsByClient.get(client)
  if (existing) {
    existing.holders += 1
    return existing
  }
  let wasActive = AppState.currentState === 'active'
  const view: HostView = { focused: new Map(), holders: 1, stopAppState: () => {} }
  const subscription = AppState.addEventListener('change', (state) => {
    // iOS passes through inactive on the way back; only the edge into or out of active is news.
    if ((state === 'active') !== wasActive) {
      wasActive = state === 'active'
      report(client, view)
    }
  })
  view.stopAppState = () => subscription.remove()
  viewsByClient.set(client, view)
  return view
}

function releaseHostView(client: RpcClient, view: HostView): void {
  view.holders -= 1
  if (view.holders === 0) {
    view.stopAppState()
    viewsByClient.delete(client)
  }
}

/**
 * Tells the session's host which session route is on screen: the focused one, while the app is in
 * the foreground. A route covered by another screen, a locked phone, or a backgrounded app is away,
 * so the host's unread dot is not muted for what nobody sees.
 */
export function usePhonePresenceReport(
  client: RpcClient | null,
  connState: ConnectionState,
  worktreeId: string
): void {
  // A transport that holds the view resends it on every session itself. One that cannot (the web
  // page's shell bridge, whose client outlives native reconnects) is told again on each connect.
  const reportsNow = !!client?.setSessionPreamble || connState === 'connected'
  const reportingClient = ORCA_SIDEBAR_INPUTS_IS_MAIN && reportsNow ? client : null
  // Held ahead of this screen's session subscription (hook order), including on a new client.
  useEffect(() => {
    if (!reportingClient) {
      return
    }
    const view = holdHostView(reportingClient)
    report(reportingClient, view)
    return () => releaseHostView(reportingClient, view)
  }, [reportingClient])
  useFocusEffect(
    useCallback(() => {
      if (!reportingClient) {
        return
      }
      const view = holdHostView(reportingClient)
      const screen = {}
      view.focused.set(screen, worktreeId)
      report(reportingClient, view)
      return () => {
        view.focused.delete(screen)
        report(reportingClient, view)
        releaseHostView(reportingClient, view)
      }
    }, [reportingClient, worktreeId])
  )
}
