import type { WebContents } from 'electron'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import type { RemoteWatcherEventBatch } from './remote-watcher-event-batch'

// ── Per-root watcher state ───────────────────────────────────────────
// WatchedRoot/WatcherSubscription live in filesystem-watcher-wsl.ts so native and WSL watchers share one shape.

// ── Module state ─────────────────────────────────────────────────────

export type LocalWatcherInstallToken = {
  cancelled: boolean
  listeners: Map<number, WebContents>
  abortController: AbortController
}

export type LocalWatcherInstallResult = 'installed' | 'unavailable' | 'capacity' | 'cancelled'

export type LocalWatcherCapacityRetry = {
  listeners: Map<number, WebContents>
  cancelWait: () => void
}

export type RemoteWatcherInstallToken = {
  cancelled: boolean
  listeners: Map<number, WebContents>
  abortController: AbortController
  abortScheduled: boolean
  terminalError?: Error
}

export type RemoteWatcherState = {
  unwatch: () => void
  listeners: Map<number, WebContents>
  installToken: RemoteWatcherInstallToken
  /** Held so every teardown can drop the trailing flush timer instead of letting it fire into a dead watch. */
  batch: RemoteWatcherEventBatch
}

// Why 'capacity' is not 'unavailable': the relay refused because its watch-root cap is full, which is
// a decision, not a fault. The 1 Hz unavailable retry cannot change that answer, and a folder
// workspace whose repo count exceeds the cap turns it into a permanent per-root storm (#11196).
export type RemoteWatcherInstallResult = 'installed' | 'unavailable' | 'capacity' | 'cancelled'

export type RemoteWatcherResyncState = {
  lastSentAt: number
  listeners: Map<number, WebContents>
  timer?: ReturnType<typeof setTimeout>
  worktreePath: string
}

// Why: cache roots that failed watcher creation (e.g. WSL UNC paths) so we don't retry every worktree switch and spam the console with errors.
export const UNWATCHABLE_ROOT_CACHE_MAX = 256
// Why: recreating @parcel/watcher on Windows is expensive (ReadDirectoryChangesW + AV, 500ms+); a 30s grace lets rapid switches reuse the watcher.
export const WATCHER_TEARDOWN_GRACE_MS = 30_000
export const REMOTE_WATCH_RETRY_MS = 1_000
export const REMOTE_WATCH_RETRY_TIMEOUT_MS = 60_000
// Why: preserve the first and latest resync while bounding full-tree SSH refreshes during flaps.
export const REMOTE_WATCH_RESYNC_COALESCE_MS = 5_000
// Why: doubling from a minute to a half-hour ceiling costs a permanently broken remote ~7 fs.watch
// calls in the first hour and 2/hour after, which a flapping link can absorb.
export const REMOTE_WATCH_DORMANT_RETRY_MS = 60_000
export const REMOTE_WATCH_DORMANT_RETRY_MAX_MS = 30 * 60_000

export const watcherLifecycleState = {
  watchedRoots: new Map<string, WatchedRoot>(),
  unwatchableRoots: new Set<string>(),
  // Why: key cleanup by sender WebContents (not per root) to avoid MaxListeners warnings when a workspace has many worktrees open.
  senderCleanupRegistered: new Set<number>(),
  pendingTeardowns: new Map<string, ReturnType<typeof setTimeout>>(),
  // Why: @parcel/watcher unsubscribe does native async work that sender-destroy can start before shutdown, so will-quit must still await it.
  pendingLocalUnsubscribes: new Set<Promise<void>>(),
  pendingLocalUnsubscribesByRoot: new Map<string, Set<Promise<void>>>(),
  suspendedLocalWatcherListeners: new Map<
    string,
    { worktreePath: string; listeners: Map<number, WebContents> }
  >(),
  // Why: an install cancelled by shutdown can't be revived by a waiter that resumes after a later call reopens the subsystem.
  localWatchersClosed: false,
  localWatcherLifecycleGeneration: 0,
  failedLocalUnsubscribes: new Map<string, unknown>(),
  // Why: a drain that timed out no longer gates the delete — Git removal already proceeded past it. Its
  // late failure must not fail-close a *later* close of the same root, which would leave that path
  // undeletable until the watcher process physically exits.
  abandonedLocalUnsubscribes: new WeakSet<Promise<void>>(),
  // Why: watcher creation is async; concurrent watch requests for the same root must share one install or later resolves orphan listeners.
  inFlightLocalInstalls: new Map<string, LocalWatcherInstallToken>(),
  pendingLocalInstallPromises: new Map<string, Promise<LocalWatcherInstallResult>>(),
  pendingLocalCapacityRetries: new Map<string, LocalWatcherCapacityRetry>(),
  // Remote watcher state
  // Key: `${connectionId}:${worktreePath}`, Value: shared remote watch state.
  remoteWatchers: new Map<string, RemoteWatcherState>(),
  suspendedRemoteWatcherListeners: new Map<
    string,
    { connectionId: string; worktreePath: string; listeners: Map<number, WebContents> }
  >(),
  // Why: the renderer subscribes once per target and never re-issues, so the intent to watch has to
  // outlive any single connection — an install that failed or died with a dropped transport is
  // re-armed from here when a provider appears. Without it a reconnect (or a connect slower than the
  // retry window) leaves the watch dead until the app restarts.
  desiredRemoteWatchers: new Map<
    string,
    { connectionId: string; worktreePath: string; listeners: Map<number, WebContents> }
  >(),
  // Why: provider registration only fires on reconnect, so a watch that dies while the SSH link stays
  // healthy (remote OOM, inotify/fd exhaustion, relay watcher killed) has no re-arm trigger at all
  // once the fast window gives up. Backoff keeps the recovery attempt without the 1s storm.
  dormantRemoteWatchers: new Map<
    string,
    { delayMs: number; timer: ReturnType<typeof setTimeout> }
  >(),
  loggedUnavailableRemoteWatchers: new Set<string>(),
  pendingRemoteWatcherRetries: new Map<string, ReturnType<typeof setTimeout>>(),
  pendingRemoteWatcherRetryListeners: new Map<
    string,
    { listeners: Map<number, WebContents>; startedAt: number; resyncOnInstall: boolean }
  >(),
  remoteWatcherResyncStates: new Map<string, RemoteWatcherResyncState>(),
  // Why: last-listener cleanup aborts relay setup; late success is unwatched rather than installed after the renderer stopped watching.
  inFlightRemoteInstalls: new Map<string, RemoteWatcherInstallToken>(),
  // Why: dedupe concurrent installRemoteWatcher calls per key so overlapping watches share one watcher instead of clobbering per-key state.
  pendingRemoteInstallPromises: new Map<string, Promise<RemoteWatcherInstallResult>>(),
  // Why: block installs beginning after closeAllWatchers (joiner recursion / retry tick bypass the abort loop); a new fs:watchWorktree clears it.
  remoteWatchersClosed: false,
  // Why: closeAllWatchers bumps this so a joiner that awaited across shutdown+reopen is refused (the latch alone can't tell it from a fresh call).
  remoteWatcherLifecycleGeneration: 0,
  unsubscribeFromProviderRegistrations: null as (() => void) | null
}
