import type { WebContents } from 'electron'
import type { WatchedRoot } from './filesystem-watcher-wsl'

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

// Why: cache roots that failed watcher creation (e.g. WSL UNC paths) so we don't retry every worktree switch and spam the console with errors.
export const UNWATCHABLE_ROOT_CACHE_MAX = 256
// Why: recreating @parcel/watcher on Windows is expensive (ReadDirectoryChangesW + AV, 500ms+); a 30s grace lets rapid switches reuse the watcher.
export const WATCHER_TEARDOWN_GRACE_MS = 30_000

// Why: a sender waiting out a cancelled install is in no listener map; unwatch and removal still need to reach it.
export type CancelledInstallWaiter = { token: symbol; sender: WebContents }
export type CancelledInstallWaiters = Map<string, Map<number, CancelledInstallWaiter>>

export const watcherLifecycleState = {
  watchedRoots: new Map<string, WatchedRoot>(),
  unwatchableRoots: new Set<string>(),
  // Why: key cleanup by sender WebContents (not per root) to avoid MaxListeners warnings when a workspace has many worktrees open.
  senderLifetimes: new Map<number, { signal: AbortSignal; dispose: () => void }>(),
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
  cancelledLocalInstallWaiters: new Map<string, Map<number, CancelledInstallWaiter>>()
}
