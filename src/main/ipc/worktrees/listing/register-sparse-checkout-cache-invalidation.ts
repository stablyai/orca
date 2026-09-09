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

/**
 * Scope worktree-change invalidation to the affected repo (falling back to a full clear when the
 * repo can't be resolved, e.g. it was already removed from the store), and forward a background
 * stale-while-revalidate flip to the same worktrees-changed notification other mutations use.
 */
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
