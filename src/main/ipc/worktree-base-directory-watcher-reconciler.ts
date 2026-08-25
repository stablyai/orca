import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import { buildWorktreeBaseDirectoryWatchTargets } from './worktree-base-directory-watch-target-cache'
import type { WorktreeBaseDirectoryWatcherRetries } from './worktree-base-directory-watcher-retries'
import type { PendingWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher-sync-queue'

export type WorktreeBaseDirectoryWatchReplacementResult = 'ready' | 'failed' | 'stale'

export async function reconcileWorktreeBaseDirectoryWatchers(
  request: PendingWorktreeBaseDirectoryWatcherSync,
  signal: AbortSignal,
  activeWatches: ReadonlyMap<string, WorktreeBaseWatchTarget>,
  retries: WorktreeBaseDirectoryWatcherRetries,
  replaceWatch: (
    target: WorktreeBaseWatchTarget,
    signal: AbortSignal
  ) => Promise<WorktreeBaseDirectoryWatchReplacementResult>,
  removeWatch: (key: string) => Promise<void>,
  refreshRetainedWatch: (key: string, repos: Map<string, WorktreeBaseRepoWatchConfig>) => void
): Promise<void> {
  const buildResult = await buildWorktreeBaseDirectoryWatchTargets(request.store, {
    fullRebuild: request.fullRebuild,
    dirtyRepoIdentities: [...request.dirtyRepoIdentities.values()],
    dirtyConnectionIds: [...request.dirtyConnectionIds],
    signal
  })
  if (signal.aborted) {
    return
  }
  const { targets } = buildResult
  retries.reconcileIntent(targets, buildResult.retries, request.store, request.mainWindow)

  const failedTargets: WorktreeBaseWatchTarget[] = []
  for (const target of targets.values()) {
    if (signal.aborted) {
      return
    }
    const result = await replaceWatch(target, signal)
    retries.recordSubscriptionResult(target, result, request.store, request.mainWindow)
    if (result === 'failed') {
      failedTargets.push(target)
    }
  }
  for (const [key, watch] of activeWatches) {
    if (signal.aborted) {
      return
    }
    const failedReplacementRepos = new Map<string, WorktreeBaseRepoWatchConfig>()
    for (const target of failedTargets) {
      if (
        target.kind === watch.kind &&
        target.connectionId === watch.connectionId &&
        [...target.repos.keys()].some((repoId) => watch.repos.has(repoId))
      ) {
        for (const [repoId, config] of target.repos) {
          if (watch.repos.has(repoId)) {
            failedReplacementRepos.set(repoId, config)
          }
        }
      }
    }
    if (!targets.has(key)) {
      if (failedReplacementRepos.size > 0) {
        refreshRetainedWatch(key, failedReplacementRepos)
      } else {
        await removeWatch(key)
      }
    }
  }
}
