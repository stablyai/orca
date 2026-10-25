import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import {
  invalidateAuthorizedRootsCache,
  markAuthorizedRootsOwnerDirty
} from './registered-worktree-roots-cache'

/** Invalidate one repo when ownership is unchanged; unknown owners fall back globally. Owner-set changes still require global invalidation. */
export function invalidateAuthorizedRootsCacheForRepo(
  store: Pick<Store, 'getRepos'> | null | undefined,
  repo: Repo | string
): void {
  if (!store || !markAuthorizedRootsOwnerDirty(store, repo)) {
    invalidateAuthorizedRootsCache()
  }
}
