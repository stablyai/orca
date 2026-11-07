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
  // Set when a buried or backgrounded page skips notices; coming back then re-reads everything once.
  let owed = false
  let lastWorktreeReadAt = 0
  let trailingRead: ReturnType<typeof setTimeout> | undefined
  const hidden = (): boolean => appState.currentState !== 'active'

  const readWorktrees = (options?: WorktreeRefreshOptions): void => {
    lastWorktreeReadAt = Date.now()
    void fetchWorktrees(options)
  }
  const readEverything = (worktreeOptions?: WorktreeRefreshOptions): void => {
    readWorktrees(worktreeOptions)
    void fetchRepoMetadata({ force: true, queueIfInFlight: true })
    void syncViewSettings({ resend: true })
  }
  const refreshWorktreesOnChange = (): void => {
    if (trailingRead) {
      return
    }
    const wait = lastWorktreeReadAt + WORKTREE_REFRESH_MS - Date.now()
    if (wait <= 0) {
      readWorktrees()
      return
    }
    trailingRead = setTimeout(() => {
      trailingRead = undefined
      if (!hidden()) {
        readWorktrees()
      }
    }, wait)
  }

  const refreshOnForeground = (): void => {
    if (hidden()) {
      return
    }
    sidebarFeed?.refresh()
    clearTimeout(trailingRead)
    trailingRead = undefined
    if (owed) {
      owed = false
      // Queued: a read still in flight was sent before the notices this page skipped.
      readEverything({ allowDuringModal: true, queueIfInFlight: true })
      return
    }
    readWorktrees({ allowDuringModal: true })
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
        if (hidden()) {
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
          owed = true
        } else {
          readEverything()
        }
      }
      return
    }
    if (event.type === 'end' || event.type === 'error') {
      eventStreamReady = false
      return
    }
    if (hidden()) {
      owed = true
      return
    }
    if (event.type === 'sidebarInputsChanged') {
      sidebarFeed?.changed(event)
    } else if (event.type === 'reposChanged') {
      // Why: folder workspace mutations publish reposChanged, and worktree.ps owns this catalog.
      refreshWorktreesOnChange()
      void fetchRepoMetadata({ force: true, queueIfInFlight: true })
    } else if (event.type === 'workspaceViewChanged') {
      void syncViewSettings()
    } else if (event.type === 'worktreesChanged') {
      refreshWorktreesOnChange()
    } else if (event.type === 'sshStateChanged') {
      // Why: host badges carry SSH health, read with the labels from ssh.listTargetSummaries.
      void fetchRepoMetadata({ force: true, queueIfInFlight: true })
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
    clearTimeout(trailingRead)
    if (interval) {
      clearInterval(interval)
    }
    stopFollowingFeed?.()
    appStateSubscription.remove()
    unsubscribe()
  }
}
