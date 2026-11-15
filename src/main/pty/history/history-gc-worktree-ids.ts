import type { Store } from '../../persistence/loading-store/store'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import { getOtherProfileWorktreeIdsForHistoryGc } from '../../orca-profiles/catalog/other-profile-workspace-catalog'
import type { HistoryGcOwners } from './terminal-history-gc'

/** Include git and folder:<id> PTY workspace keys; omitting folder workspaces makes their live shell history appear orphaned. */
export function getKnownWorktreeIdsForHistoryGc(
  store: Pick<
    Store,
    'getAllWorktreeMeta' | 'getFolderWorkspaces' | 'getRepos' | 'getWorkspaceSession'
  >,
  readOtherProfiles = getOtherProfileWorktreeIdsForHistoryGc
): HistoryGcOwners {
  const live = new Set(Object.keys(store.getAllWorktreeMeta()))
  for (const workspace of store.getFolderWorkspaces()) {
    live.add(folderWorkspaceKey(workspace.id))
  }
  // A persisted tab restores its panes, so its worktree still owns their history.
  for (const [worktreeId, tabs] of Object.entries(store.getWorkspaceSession().tabsByWorktree)) {
    if (tabs.length > 0) {
      live.add(worktreeId)
    }
  }
  // History spans profiles; include all owners. If any profile is unreadable, return empty (prune nothing), never a destructive partial set.
  const others = readOtherProfiles()
  if (others.unreadableProfiles > 0) {
    console.warn(
      `[pty:history:gc] Skipping GC: ${others.unreadableProfiles} profile(s) could not be read`
    )
    return { liveWorktreeIds: new Set(), localRepoPaths: new Map() }
  }
  for (const id of others.ids) {
    live.add(id)
  }
  return { liveWorktreeIds: live, localRepoPaths: localOnlyRepoPaths(store, others.repoIds) }
}

/** A local stat can only prove a worktree gone for repos this machine alone hosts. */
function localOnlyRepoPaths(
  store: Pick<Store, 'getRepos'>,
  otherProfileRepoIds: ReadonlySet<string>
): Map<string, string> {
  const paths = new Map<string, string>()
  const remote = new Set(otherProfileRepoIds)
  for (const repo of store.getRepos()) {
    if (isRepoOnCatalogHost(repo)) {
      paths.set(repo.id, repo.path)
    } else {
      remote.add(repo.id)
    }
  }
  for (const id of remote) {
    paths.delete(id)
  }
  return paths
}
