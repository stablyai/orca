import {
  subscribeSharedClientEvents,
  type SharedClientEventsClient
} from '../transport/connection/shared-client-events'
import type { HostSidebarFeedTriggers } from '../host-screen/sidebar-feed/host-sidebar-feed-connection'

// Keep lifecycle callers independent of RN types.
type HostAppState = {
  currentState: string | null | undefined
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void }
}

type HostWorktreeRefreshArgs = {
  client: SharedClientEventsClient
  /** Reads the worktree catalog again, after any read already out. */
  refreshWorktrees: () => void
  /** Re-reads the Workspace options the phone shares with the desktop; `resend` retries unanswered changes. */
  syncViewSettings: (options?: { resend?: boolean }) => Promise<void>
  /** The host's sidebar feed, which replaces the poll: its notices say when anything changed. */
  sidebarFeed?: HostSidebarFeedTriggers | null
  /** React Native's AppState; passed in so the lifecycle also runs off the device. */
  appState: HostAppState
}

/**
 * The host list's reads that are not query families: the shared Workspace options and the sidebar
 * feed. The catalog, repos and server rows are queries the event router keeps fresh.
 */
export function startHostWorktreeRefresh({
  client,
  refreshWorktrees,
  syncViewSettings,
  sidebarFeed,
  appState
}: HostWorktreeRefreshArgs): () => void {
  let stale = false
  // Set when a buried or backgrounded page skips a notice; coming back then re-reads the options once.
  let owed = false
  const hidden = (): boolean => appState.currentState !== 'active'

  const appStateSubscription = appState.addEventListener('change', (state) => {
    if (state !== 'active' || hidden()) {
      return
    }
    sidebarFeed?.refresh()
    if (owed) {
      owed = false
      void syncViewSettings({ resend: true })
    }
  })
  const unsubscribe = subscribeSharedClientEvents(client, (event) => {
    if (stale) {
      return
    }
    if (event.type === 'ready') {
      // Every ready: a change between the last read and this subscription sent no notice.
      sidebarFeed?.refresh()
      // A reconnect or a reopened stream missed the notices in between.
      if ('replayed' in event) {
        if (hidden()) {
          owed = true
        } else {
          void syncViewSettings({ resend: true })
        }
      }
      return
    }
    if (event.type === 'end' || event.type === 'error') {
      return
    }
    if (event.type === 'workspaceViewChanged') {
      if (hidden()) {
        owed = true
      } else {
        void syncViewSettings()
      }
    } else if (event.type === 'sidebarInputsChanged' && !hidden()) {
      // Coming back to the foreground refreshes the feed anyway.
      sidebarFeed?.changed(event)
    }
  })

  // A row's live content (agents, terminals) may follow any install; worktree.ps carries it.
  const stopFollowingFeed = sidebarFeed?.onInstalled(refreshWorktrees)
  sidebarFeed?.refresh()
  // A lost write predates the new lifecycle’s replayed ready; explicitly resend it on reconnect.
  void syncViewSettings({ resend: true })

  return () => {
    stale = true
    stopFollowingFeed?.()
    appStateSubscription.remove()
    unsubscribe()
  }
}
