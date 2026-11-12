import {
  collectLocalWorktreeBaseChanges,
  hasCollectedWorktreeBaseChanges
} from './worktree-base-directory-change-collector'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import {
  invalidateActiveGitStatusRefResolution,
  invalidateGitStatusRefResolutionForPaths
} from '../git/worktree-git-status-ref-watch'
import type { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'
import { runWorktreeChangeInvalidators } from '../listing/worktree-change-invalidators'

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
    // Events were lost: no reader may reuse rows observed before the gap, even while notification is paced.
    for (const repoId of watch.repos.keys()) {
      runWorktreeChangeInvalidators(repoId)
    }
    const refresh = (): void => {
      if (!watch.disposed && !watch.mainWindow.isDestroyed()) {
        scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
      }
    }
    if (watch.watcherFailureRefresh.consume()) {
      refresh()
    } else {
      watch.watcherFailureRefresh.defer(refresh)
    }
    return
  }
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

// Overflow proves event loss; refresh structure, status and heads without the transient-error cooldown.
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
