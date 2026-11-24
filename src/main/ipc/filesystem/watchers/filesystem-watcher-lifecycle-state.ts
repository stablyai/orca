import type { WebContents } from 'electron'
import type { WatchedRoot } from './filesystem-watcher-wsl'

export type LocalWatcherInstallToken = {
  cancelled: boolean
  listeners: Map<number, WebContents>
  abortController: AbortController
}

// 'capacity': retry scheduled, not unwatchable (watcher capacity, or a stopped WSL distro).
export type LocalWatcherInstallResult = 'installed' | 'unavailable' | 'capacity' | 'cancelled'

export type LocalWatcherCapacityRetry = {
  listeners: Map<number, WebContents>
  cancelWait: () => void
}

// Cache failed roots to suppress repeated creation attempts and error spam on switches.
export const UNWATCHABLE_ROOT_CACHE_MAX = 256
// Windows watcher setup can cost 500ms+; retain a grace window for rapid switches.
export const WATCHER_TEARDOWN_GRACE_MS = 30_000

// Cancelled-install waiters need separate ownership while absent from listener maps.
export type CancelledInstallWaiter = { token: symbol; sender: WebContents }
export type CancelledInstallWaiters = Map<string, Map<number, CancelledInstallWaiter>>

export const watcherLifecycleState = {
  watchedRoots: new Map<string, WatchedRoot>(),
  unwatchableRoots: new Set<string>(),
  // One lifetime per WebContents avoids per-root MaxListeners warnings.
  senderLifetimes: new Map<number, { signal: AbortSignal; dispose: () => void }>(),
  pendingTeardowns: new Map<string, ReturnType<typeof setTimeout>>(),
  // Shutdown must await native unsubscribe work already started by destroyed senders.
  pendingLocalUnsubscribes: new Set<Promise<void>>(),
  pendingLocalUnsubscribesByRoot: new Map<string, Set<Promise<void>>>(),
  suspendedLocalWatcherListeners: new Map<
    string,
    { worktreePath: string; listeners: Map<number, WebContents> }
  >(),
  // Generation fencing prevents reopened subsystems from reviving retired waiters.
  localWatchersClosed: false,
  localWatcherLifecycleGeneration: 0,
  failedLocalUnsubscribes: new Map<string, unknown>(),
  // A timed-out drain no longer owns deletion; late failures must not make later removal impossible.
  abandonedLocalUnsubscribes: new WeakSet<Promise<void>>(),
  // Share async installs so concurrent resolutions cannot orphan listeners.
  inFlightLocalInstalls: new Map<string, LocalWatcherInstallToken>(),
  pendingLocalInstallPromises: new Map<string, Promise<LocalWatcherInstallResult>>(),
  pendingLocalCapacityRetries: new Map<string, LocalWatcherCapacityRetry>(),
  cancelledLocalInstallWaiters: new Map<string, Map<number, CancelledInstallWaiter>>()
}
