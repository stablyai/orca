import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges,
  hasCollectedWorktreeBaseChanges
} from './worktree-base-directory-change-collector'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import {
  invalidateActiveGitStatusRefResolution,
  invalidateGitStatusRefResolutionForPaths
} from './worktree-git-status-ref-watch'
import type { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'

export type ActiveWatch = WorktreeBaseNotificationWatch & {
  subscription: { unsubscribe: () => Promise<void> }
  gitStatusRefPaths: Set<string>
  watcherFailureRefresh: WorktreeWatcherFailureRefreshCooldown
}

export function handleLocalWatchEvents(
  watch: ActiveWatch,
  error: Error | null,
  events: { type: 'create' | 'update' | 'delete'; path: string }[],
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  if (error) {
    console.warn(`[worktree-base-watcher] watcher failed for ${watch.path}:`, error)
    invalidateActiveGitStatusRefResolution(watch, getActiveWatches)
    if (watch.watcherFailureRefresh.consume()) {
      scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    }
    return
  }
  watch.watcherFailureRefresh.reset()
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.map((event) => event.path),
    getActiveWatches
  )
  const changes = collectLocalWorktreeBaseChanges(watch, events)
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

// Why: after a dropped event batch nothing about the prior state can be
// trusted — widen unconditionally (structural + status + head-identity),
// same shape as the remote overflow branch below, bypassing the watcher-error
// cooldown so a burst of overflows during one bulk op cannot suppress the
// refresh the fleet actually needs.
export function handleWatchOverflow(
  watch: ActiveWatch,
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  invalidateActiveGitStatusRefResolution(watch, getActiveWatches)
  scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
}

export function handleRemoteWatchEvents(
  watch: ActiveWatch,
  events: Parameters<typeof collectRemoteWorktreeBaseChanges>[1],
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.flatMap((event) =>
      event.kind === 'overflow' ? [] : [event.absolutePath, event.oldAbsolutePath]
    ),
    getActiveWatches
  )
  const changes = collectRemoteWorktreeBaseChanges(watch, events)
  if (changes.overflow) {
    handleWatchOverflow(watch, getActiveWatches)
    return
  }
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}
