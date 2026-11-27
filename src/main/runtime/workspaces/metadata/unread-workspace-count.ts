import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  runtimeVisibleFolderWorkspaces,
  runtimeVisibleRepos
} from '../catalog/runtime-visible-catalog'

type UnreadCountStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getProjectGroups'
  | 'getFolderWorkspaces'
  | 'getSshTargets'
  | 'getProjectHostSetups'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
>

// A paired runtime keeps its own workspaces' unread flags and counts them itself.
function isOwnHost(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind !== 'runtime'
}

/** Unread, unarchived workspaces whose records this host owns: its sidebar dots, minus paired runtimes'. */
export function countUnreadWorkspaces(store: UnreadCountStore | null): number {
  if (!store) {
    return 0
  }
  const repoIdsByHost = new Map<ExecutionHostId, Set<string>>()
  for (const repo of runtimeVisibleRepos(store)) {
    const hostId = getRepoExecutionHostId(repo)
    if (isOwnHost(hostId)) {
      const repoIds = repoIdsByHost.get(hostId) ?? new Set<string>()
      repoIds.add(repo.id)
      repoIdsByHost.set(hostId, repoIds)
    }
  }
  let count = 0
  for (const [hostId, repoIds] of repoIdsByHost) {
    for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
      if (meta.isUnread && !meta.isArchived && repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
        count++
      }
    }
  }
  for (const folder of runtimeVisibleFolderWorkspaces(store)) {
    if (
      folder.isUnread &&
      !folder.isArchived &&
      (!folder.executionHostId || isOwnHost(folder.executionHostId))
    ) {
      count++
    }
  }
  return count
}
