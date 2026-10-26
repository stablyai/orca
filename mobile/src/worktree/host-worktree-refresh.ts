import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSidebarFeedTriggers } from '../host-screen/host-sidebar-feed-connection'

const WORKTREE_REFRESH_MS = 3000

type WorktreeRefreshOptions = { allowDuringModal?: boolean; queueIfInFlight?: boolean }
type RepoRefreshOptions = { force?: boolean; queueIfInFlight?: boolean }

// Keep lifecycle callers independent of RN types.
type HostAppState = {
  currentState: string
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void }
}

type HostWorktreeRefreshArgs = {
  client: Pick<RpcClient, 'subscribe'>
  fetchWorktrees: (options?: WorktreeRefreshOptions) => Promise<void>
  fetchRepoMetadata: (options?: RepoRefreshOptions) => Promise<void>
  /** Re-reads the Workspace options the phone shares with the desktop; `resend` retries unanswered changes. */
  syncViewSettings: (options?: { resend?: boolean }) => Promise<void>
  /** The host's sidebar feed, which replaces the poll: its notices say when anything changed. */
  sidebarFeed?: HostSidebarFeedTriggers | null
  /** React Native's AppState; passed in so the lifecycle also runs off the device. */
  appState: HostAppState
}

export function startHostWorktreeRefresh({
  client,
  fetchWorktrees,
  fetchRepoMetadata,
  syncViewSettings,
  sidebarFeed,
  appState
}: HostWorktreeRefreshArgs): () => void {
  let stale = false
  let eventStreamReady = false

  const refreshOnForeground = (): void => {
    if (appState.currentState !== 'active') {
      return
    }
    sidebarFeed?.refresh()
    void fetchWorktrees({ allowDuringModal: true })
    void fetchRepoMetadata({ queueIfInFlight: true })
  }

  const appStateSubscription = appState.addEventListener('change', (state) => {
    if (state === 'active') {
      refreshOnForeground()
    }
  })
  const interval = sidebarFeed
    ? null
    : setInterval(() => {
        if (appState.currentState !== 'active') {
          return
        }
        void fetchWorktrees()
        // Older hosts emit no reposChanged; retain foreground repo polling, self-throttled to once a minute.
        void fetchRepoMetadata()
      }, WORKTREE_REFRESH_MS)
  const unsubscribe = client.subscribe(
    'runtime.clientEvents.subscribe',
    null,
    (payload: unknown) => {
      if (stale || !payload || typeof payload !== 'object') {
        return
      }
      const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
      if (event.type === 'ready') {
        // Every ready: a change between the last read and this subscription sent no notice.
        sidebarFeed?.refresh()
        const replayedAfterReconnect = eventStreamReady
        eventStreamReady = true
        if (replayedAfterReconnect) {
          // Why: client events are not queued while disconnected, so re-read both snapshots after replay.
          void fetchWorktrees()
          void fetchRepoMetadata({ force: true, queueIfInFlight: true })
          void syncViewSettings({ resend: true })
        }
        return
      }
      if (event.type === 'end' || event.type === 'error') {
        eventStreamReady = false
        return
      }
      if (event.type === 'sidebarInputsChanged') {
        sidebarFeed?.changed(event)
      } else if (event.type === 'reposChanged') {
        // Why: folder workspace mutations publish reposChanged, and worktree.ps owns this catalog.
        void fetchWorktrees()
        void fetchRepoMetadata({ force: true, queueIfInFlight: true })
      } else if (event.type === 'workspaceViewChanged') {
        void syncViewSettings()
      } else if (event.type === 'worktreesChanged') {
        void fetchWorktrees()
      } else if (event.type === 'sshStateChanged') {
        // Why: host badges carry SSH health, read with the labels from ssh.listTargetSummaries.
        void fetchRepoMetadata({ force: true, queueIfInFlight: true })
      }
    }
  )

  // A row's live content (agents, terminals) may follow any install; worktree.ps carries it.
  const stopFollowingFeed = sidebarFeed?.onInstalled(
    () => void fetchWorktrees({ queueIfInFlight: true })
  )
  sidebarFeed?.refresh()
  void fetchWorktrees()
  void fetchRepoMetadata({ force: true, queueIfInFlight: true })
  // A lost write predates the new lifecycle’s replayed ready; explicitly resend it on reconnect.
  void syncViewSettings({ resend: true })

  return () => {
    stale = true
    if (interval) {
      clearInterval(interval)
    }
    stopFollowingFeed?.()
    appStateSubscription.remove()
    unsubscribe()
  }
}
