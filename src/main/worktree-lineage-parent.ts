import type { Store } from './persistence'
import { getRepoExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import { splitWorktreeId } from '../shared/worktree/id'
import { readWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from './worktree-metadata-ownership'
import { createLineageResolutionContext } from './ipc/worktrees/metadata/lineage-owner-resolution'
import { resolveFolderLineageOwner } from './ipc/worktrees/metadata/workspace-lineage-filtering'
import { getFolderWorkspaceExecutionHostId } from '../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../shared/workspace-scope'

type LineageParentStore = Pick<Store, 'getRepos' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getWorktreeMetaForHost' | 'getFolderWorkspaces' | 'getProjectGroups'>>

export function readWorkspaceLineageParent(
  store: LineageParentStore,
  workspaceKey: string,
  hostId: ExecutionHostId
): { instanceId: string | null } | null {
  const scope = parseWorkspaceKey(workspaceKey)
  if (scope?.type === 'folder') {
    return readFolderLineageParentHost(store, scope.folderWorkspaceId) === hostId
      ? { instanceId: null }
      : null
  }
  const meta =
    scope?.type === 'worktree'
      ? readWorktreeLineageParentMeta(store, scope.worktreeId, hostId)
      : undefined
  return meta?.instanceId ? { instanceId: meta.instanceId } : null
}

export function readWorktreeLineageParentMeta(
  store: LineageParentStore,
  worktreeId: string,
  hostId: ExecutionHostId
) {
  const repoId = splitWorktreeId(worktreeId)?.repoId
  const owners = store.getRepos().filter((repo) => repo.id === repoId)
  const matching = owners.filter((repo) => getRepoExecutionHostId(repo) === hostId)
  if (matching.length !== 1) {
    return undefined
  }
  const legacy = store.getWorktreeMeta(worktreeId)
  const meta =
    readWorktreeMetaForHost(store, worktreeId, hostId) ??
    getRepoOwnedWorktreeMeta(
      matching[0],
      worktreeId,
      legacy ? { [worktreeId]: legacy } : {},
      owners.length
    )
  // A sole repo owner does not override a contradictory metadata stamp.
  return meta && (!meta.hostId || meta.hostId === hostId) ? meta : undefined
}

export function readFolderLineageParentHost(
  store: LineageParentStore,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const context = createLineageResolutionContext(store)
  const owner = resolveFolderLineageOwner(context, folderWorkspaceId)
  const folder = context.foldersById.get(folderWorkspaceId)?.[0]
  // Accept only ownership that the folder row's renderer projection also preserves.
  return owner.status === 'owned' &&
    folder &&
    getFolderWorkspaceExecutionHostId(folder) === owner.hostId
    ? owner.hostId
    : null
}
