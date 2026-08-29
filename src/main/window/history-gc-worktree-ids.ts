import type { Store } from '../persistence'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { getOtherProfileWorktreeIdsForHistoryGc } from './history-gc-profile-worktree-ids'

/**
 * Every workspace key that owns shell history, for the history GC's live set.
 *
 * Why folder workspaces are included: a folder workspace's PTY carries
 * `folder:<id>` as its worktree id (see folder-workspace-composer-submit.ts),
 * so `injectHistoryEnv` mints history under that key exactly as it does for a
 * git worktree. They live in a separate store collection, so a set built only
 * from `getAllWorktreeMeta()` makes every live folder workspace look orphaned —
 * and the GC then deletes history the user is still accumulating.
 */
export function getKnownWorktreeIdsForHistoryGc(
  store: Pick<Store, 'getAllWorktreeMeta' | 'getFolderWorkspaces'>,
  readOtherProfiles = getOtherProfileWorktreeIdsForHistoryGc
): Set<string> {
  const live = new Set(Object.keys(store.getAllWorktreeMeta()))
  for (const workspace of store.getFolderWorkspaces()) {
    live.add(folderWorkspaceKey(workspace.id))
  }
  // Why the other profiles too: the history root is not profile-scoped but this
  // store is, so on its own the live set condemns every other profile's history
  // the moment the user switches. An unreadable profile means those ids are
  // unknown, and an incomplete live set is exactly what deletes real history —
  // so report the empty set, which runHistoryGc treats as "prune nothing".
  const others = readOtherProfiles()
  if (others.unreadableProfiles > 0) {
    console.warn(
      `[pty:history:gc] Skipping GC: ${others.unreadableProfiles} profile(s) could not be read`
    )
    return new Set()
  }
  for (const id of others.ids) {
    live.add(id)
  }
  return live
}
