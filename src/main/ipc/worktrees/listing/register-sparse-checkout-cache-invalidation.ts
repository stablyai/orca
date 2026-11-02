import type { BrowserWindow } from 'electron'
import type { Store } from '../../../persistence/loading-store/store'
import {
  clearSparseCheckoutStateCache,
  clearSparseCheckoutStateCacheForRepo,
  onSparseCheckoutStateChanged
} from '../../../git/worktree-sparse-checkout-cache'
import { areWorktreePathsEqual } from '../../../git/worktree-path-comparison'
import { registerWorktreeChangeInvalidator } from '../../worktree-change-invalidators'
import { notifyWorktreesChanged } from '../../worktree-remote'

/** Invalidate the changed repo, clearing all if unresolved; publish stale-while-revalidate flips as worktree changes. */
export function registerSparseCheckoutCacheInvalidation(
  mainWindow: BrowserWindow,
  store: Store
): () => void {
  const unregisterInvalidator = registerWorktreeChangeInvalidator((repoId) => {
    const repoPath = store.getRepo(repoId)?.path
    if (repoPath) {
      clearSparseCheckoutStateCacheForRepo(repoPath)
    } else {
      clearSparseCheckoutStateCache()
    }
  })
  onSparseCheckoutStateChanged((repoPath) => {
    const repo = store
      .getRepos()
      .find((candidate) => areWorktreePathsEqual(candidate.path, repoPath))
    if (repo) {
      notifyWorktreesChanged(mainWindow, repo.id)
    }
  })
  return () => {
    unregisterInvalidator()
    onSparseCheckoutStateChanged(undefined)
  }
}
