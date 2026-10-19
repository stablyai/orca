import { AppState } from 'react-native'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSidebarFeedTriggers } from '../host-screen/host-sidebar-feed-reader'

const WORKTREE_REFRESH_MS = 3000

type WorktreeRefreshOptions = { allowDuringModal?: boolean; queueIfInFlight?: boolean }
type RepoRefreshOptions = { force?: boolean; queueIfInFlight?: boolean }

type HostWorktreeRefreshArgs = {
  client: RpcClient
  fetchWorktrees: (options?: WorktreeRefreshOptions) => Promise<void>
  fetchRepoMetadata: (options?: RepoRefreshOptions) => Promise<void>
  /** Re-reads the Workspace options the phone shares with the desktop. */
  syncViewSettings: (options?: { reconnected?: boolean }) => Promise<void>
  /** The host's sidebar feed, which replaces the poll: its notices say when anything changed. */
  sidebarFeed?: HostSidebarFeedTriggers | null
}

export function startHostWorktreeRefresh({
  client,
  fetchWorktrees,
  fetchRepoMetadata,
  syncViewSettings,
  sidebarFeed
}: HostWorktreeRefreshArgs): () => void {
  let stale = false
  let eventStreamReady = false

  const refreshOnForeground = (): void => {
    if (AppState.currentState !== 'active') {
      return
    }
    sidebarFeed?.refresh()
    void fetchWorktrees({ allowDuringModal: true })
    void fetchRepoMetadata({ queueIfInFlight: true })
  }

  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      refreshOnForeground()
    }
  })
  const interval = sidebarFeed
    ? null
    : setInterval(() => {
        if (AppState.currentState !== 'active') {
          return
        }
        void fetchWorktrees()
        // Why: desktop Settings repo edits (icon/color/name, repo removal) now emit `reposChanged`
        // (#11994), but a host on an older build does not; keep this periodic repo.list as the
        // convergence safety-net. fetchRepoMetadata self-throttles to REPO_METADATA_REFRESH_MS
        // (60s), so this is ~1 request/min while foregrounded — the AppState gate is what removes
        // the waste (both stop while backgrounded).
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
          void syncViewSettings({ reconnected: true })
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
