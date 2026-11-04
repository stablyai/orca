import * as path from 'node:path'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import type { WatchedRoot } from './filesystem-watcher-wsl'

/** Observe existing renderer-driven subscriptions without starting or retaining watchers. */
export type LocalWatcherEventObserver = {
  onEvents(root: WatchedRoot, events: readonly WatcherEvent[]): void
  /** Overflow, child restart, or watcher error: path precision was lost. */
  onInterrupted(root: WatchedRoot): void
}

const observers = new Set<LocalWatcherEventObserver>()

export function observeLocalWatcherEvents(observer: LocalWatcherEventObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

export function notifyLocalWatcherEvents(root: WatchedRoot, events: readonly WatcherEvent[]): void {
  for (const observer of observers) {
    observer.onEvents(root, events)
  }
}

export function notifyLocalWatcherInterrupted(root: WatchedRoot): void {
  for (const observer of observers) {
    observer.onInterrupted(root)
  }
}

export function findCoveringLocalWatchRoot(targetPath: string): WatchedRoot | null {
  if (watcherLifecycleState.watchedRoots.size === 0) {
    return null
  }
  const pathApi = isWindowsAbsolutePathLike(targetPath) ? path.win32 : path.posix
  let current = pathApi.resolve(targetPath)
  while (true) {
    const root = watcherLifecycleState.watchedRoots.get(getLocalWatcherRoot(current).key)
    if (root) {
      return root
    }
    const parent = pathApi.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}
