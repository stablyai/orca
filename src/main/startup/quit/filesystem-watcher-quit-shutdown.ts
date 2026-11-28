import { closeAllWatchers } from '../../ipc/filesystem/watchers/filesystem-watcher-shutdown'
import { disposeWorktreeBaseDirectoryWatchers } from '../../ipc/worktrees/creation/worktree-base-directory-watcher'
import { stopFolderRepoGitUpgradeWatch } from '../../ipc/worktrees/listing/folder-repo-git-upgrade'
import { mainProcessState as state } from '../main-process-state'

let watcherShutdownPromise: Promise<void> | null = null

export function shutdownWatchersOnce(): Promise<void> {
  if (state.core.watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Await native watcher unsubscribe before Node environment teardown.
    stopFolderRepoGitUpgradeWatch()
    watcherShutdownPromise = Promise.allSettled([
      closeAllWatchers(),
      disposeWorktreeBaseDirectoryWatchers()
    ])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[filesystem-watcher] shutdown failed:', result.reason)
          }
        }
      })
      .then(() => {
        state.core.watcherShutdownDone = true
      })
  }
  return watcherShutdownPromise
}
