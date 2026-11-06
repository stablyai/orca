import {
  subscribeSharedClientEvents,
  type SharedClientEventsClient
} from '../transport/shared-client-events'
import type { HostSidebarFeedTriggers } from '../host-screen/host-sidebar-feed-connection'

// Also the floor between change-driven reads, which arrive per agent step (Home throttles the same).
const WORKTREE_REFRESH_MS = 3000

type WorktreeRefreshOptions = { allowDuringModal?: boolean; queueIfInFlight?: boolean }
type RepoRefreshOptions = { force?: boolean; queueIfInFlight?: boolean }

// Keep lifecycle callers independent of RN types.
type HostAppState = {
  currentState: string
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void }
}

type HostWorktreeRefreshArgs = {
  client: SharedClientEventsClient
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
  // A buried or backgrounded page reads nothing on change notices; the foreground refresh catches up.
  let worktreesOwed = false
  let reposOwed = false
  let viewSettingsOwed = false
  let lastWorktreeReadAt = 0
  let trailingChangeRefresh: ReturnType<typeof setTimeout> | null = null
  const hidden = (): boolean => appState.currentState !== 'active'

  const readWorktrees = (options?: WorktreeRefreshOptions): void => {
    lastWorktreeReadAt = Date.now()
    void fetchWorktrees(options)
  }
  const refreshWorktreesOnChange = (): void => {
    if (hidden()) {
      worktreesOwed = true
      return
    }
    if (trailingChangeRefresh) {
      return
    }
    const wait = lastWorktreeReadAt + WORKTREE_REFRESH_MS - Date.now()
    if (wait <= 0) {
      readWorktrees()
      return
    }
    trailingChangeRefresh = setTimeout(() => {
      trailingChangeRefresh = null
      if (!hidden()) {
        readWorktrees()
      }
    }, wait)
  }
  const refreshReposOnChange = (): void => {
    if (hidden()) {
      reposOwed = true
    } else {
      void fetchRepoMetadata({ force: true, queueIfInFlight: true })
    }
  }
  const syncViewSettingsOnChange = (resend: boolean): void => {
    if (hidden()) {
      viewSettingsOwed = true
    } else {
      void (resend ? syncViewSettings({ resend }) : syncViewSettings())
    }
  }

  const refreshOnForeground = (): void => {
    if (hidden()) {
      return
    }
    sidebarFeed?.refresh()
    if (trailingChangeRefresh) {
      clearTimeout(trailingChangeRefresh)
      trailingChangeRefresh = null
    }
    // Queued after skipped notices: a read still in flight was sent before them.
    readWorktrees({ allowDuringModal: true, ...(worktreesOwed ? { queueIfInFlight: true } : {}) })
    void fetchRepoMetadata(
      reposOwed ? { force: true, queueIfInFlight: true } : { queueIfInFlight: true }
    )
    if (viewSettingsOwed) {
      void syncViewSettings({ resend: true })
    }
    worktreesOwed = false
    reposOwed = false
    viewSettingsOwed = false
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
  const unsubscribe = subscribeSharedClientEvents(client, (event) => {
    if (stale) {
      return
    }
    if (event.type === 'ready') {
      // Every ready: a change between the last read and this subscription sent no notice.
      sidebarFeed?.refresh()
      const replayedAfterReconnect = eventStreamReady
      eventStreamReady = true
      if (replayedAfterReconnect) {
        // Why: client events are not queued while disconnected, so re-read both snapshots after replay.
        if (hidden()) {
          worktreesOwed = true
        } else {
          readWorktrees()
        }
        refreshReposOnChange()
        syncViewSettingsOnChange(true)
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
      refreshWorktreesOnChange()
      refreshReposOnChange()
    } else if (event.type === 'workspaceViewChanged') {
      syncViewSettingsOnChange(false)
    } else if (event.type === 'worktreesChanged') {
      refreshWorktreesOnChange()
    } else if (event.type === 'sshStateChanged') {
      // Why: host badges carry SSH health, read with the labels from ssh.listTargetSummaries.
      refreshReposOnChange()
    }
  })

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
    if (trailingChangeRefresh) {
      clearTimeout(trailingChangeRefresh)
    }
    if (interval) {
      clearInterval(interval)
    }
    stopFollowingFeed?.()
    appStateSubscription.remove()
    unsubscribe()
  }
}
