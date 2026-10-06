import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import {
  invalidateAuthorizedRootsCache,
  markAuthorizedRootsOwnerDirty
} from './registered-worktree-roots-cache'

/**
 * Scoped counterpart to `invalidateAuthorizedRootsCache` for a change whose blast
 * radius is provably one repo — every worktree create and removal.
 *
 * Why this exists: the global form dirties every registered owner, so the next
 * authorization-requiring IPC rebuilds by listing EVERY repo. At 58 repos that is 58
 * `git worktree list` spawns — roughly ten seconds of git wall-clock through an
 * admission budget of four — to rediscover roots only one repo changed.
 *
 * Falls back to the global form rather than silently skipping an invalidation, which
 * would leave a stale allowlist. Callers whose change can alter the owner SET rather
 * than one repo's roots (store swap, execution-host/WSL re-routing, nested-repo
 * import, folder->git upgrade) must keep using the global form.
 */
export function invalidateAuthorizedRootsCacheForRepo(
  store: Store | null | undefined,
  repo: Repo | string
): void {
  if (!store || !markAuthorizedRootsOwnerDirty(store, repo)) {
    invalidateAuthorizedRootsCache()
  }
}
