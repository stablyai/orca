import type { Store } from '../persistence'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { getOtherProfileWorktreeIdsForHistoryGc } from '../orca-profiles/other-profile-workspace-catalog'

/** Include git and folder:<id> PTY workspace keys; omitting folder workspaces makes their live shell history appear orphaned. */
export function getKnownWorktreeIdsForHistoryGc(
  store: Pick<Store, 'getAllWorktreeMeta' | 'getFolderWorkspaces'>,
  readOtherProfiles = getOtherProfileWorktreeIdsForHistoryGc
): Set<string> {
  const live = new Set(Object.keys(store.getAllWorktreeMeta()))
  for (const workspace of store.getFolderWorkspaces()) {
    live.add(folderWorkspaceKey(workspace.id))
  }
  // History spans profiles; include all owners. If any profile is unreadable, return empty (prune nothing), never a destructive partial set.
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
