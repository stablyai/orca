import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts
} from '../../../../shared/sidebar-list/hosts/host-filtering'
import { getRenderableFolderWorkspaces } from '../../../../shared/sidebar-list/folders/folder-workspace-lanes'
import { worktreeMatchesVisibleHost } from '@/components/sidebar/worktree-list/listing/visible-worktree-host-scope'
import {
  filterFolderWorkspacesFromOtherDevices,
  isWorkspaceOwnedBySomeoneElse
} from '../../../../shared/workspace-view/workspace-creator-visibility'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isWorktreeRetiredByRemoval } from '../../../../shared/worktree/removal/removal-visibility'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'

export type UnreadBadgeCountSources = {
  worktreeBuckets: Readonly<Record<string, readonly Worktree[]>>
  folders: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repoMap: Map<string, Repo>
  /** null when the sidebar shows every host. */
  visibleHostIds: ReadonlySet<ExecutionHostId> | null
  defaultHostId: ExecutionHostId
  /** null unless the sidebar hides workspaces created from other devices. */
  hiddenOtherDevicePairings: ReadonlyMap<string, string> | null
}

/** Unread worktrees in one repo bucket; each row counts its flag, as the sidebar dot does. */
export function countUnreadWorktreesInBucket(
  worktrees: readonly Worktree[],
  sources: Omit<UnreadBadgeCountSources, 'worktreeBuckets' | 'folders' | 'projectGroups'>
): number {
  const { visibleHostIds, defaultHostId } = sources
  // Why host-keyed: the sidebar shows same-id copies on two hosts as two rows; ids embed the repo, so buckets never share one.
  const unreadWorktrees = new Set<string>()
  for (const worktree of worktrees) {
    // Why: the sidebar never renders an archived worktree, nor one on a host it is not showing.
    if (
      worktree.isUnread &&
      !worktree.isArchived &&
      !isWorktreeRetiredByRemoval(worktree) &&
      (!sources.hiddenOtherDevicePairings ||
        !isWorkspaceOwnedBySomeoneElse(worktree, sources.hiddenOtherDevicePairings)) &&
      worktreeMatchesVisibleHost(worktree, visibleHostIds, sources.repoMap, defaultHostId)
    ) {
      unreadWorktrees.add(getWorktreeHostIdentity(worktree))
    }
  }
  return unreadWorktrees.size
}

/** Unread folder workspaces through the same membership steps the sidebar runs before building rows. */
export function countUnreadFolderRows(
  sources: Omit<UnreadBadgeCountSources, 'worktreeBuckets' | 'repoMap'>
): number {
  const { projectGroups, visibleHostIds, defaultHostId, hiddenOtherDevicePairings } = sources
  const unread = sources.folders.filter((folder) => folder.isUnread)
  if (unread.length === 0) {
    return 0
  }
  const onVisibleHosts = filterFolderWorkspacesForVisibleHosts(
    unread,
    projectGroups,
    visibleHostIds,
    defaultHostId
  )
  const rows = getRenderableFolderWorkspaces(
    hiddenOtherDevicePairings
      ? filterFolderWorkspacesFromOtherDevices(onVisibleHosts, hiddenOtherDevicePairings)
      : onVisibleHosts,
    filterProjectGroupsForVisibleHosts(projectGroups, visibleHostIds, defaultHostId)
  )
  return new Set(rows.map(({ folderWorkspace }) => getFolderWorkspaceHostIdentity(folderWorkspace)))
    .size
}
