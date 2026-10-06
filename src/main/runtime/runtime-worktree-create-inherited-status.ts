import { getWorktreeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceStatus } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type {
  ResolvedWorkspaceParent,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'

export type ParentWorkspaceStatusStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getWorktreeMetaForHost'>>

// Why: a child that starts in the default status lands in a different status lane than its
// parent, splitting the lineage group until someone moves it by hand.
export function withParentWorkspaceStatus(
  request: RuntimeManagedWorktreeCreateArgs,
  lineage: WorktreeLineageResolution,
  store: ParentWorkspaceStatusStore | null
): RuntimeManagedWorktreeCreateArgs {
  if (request.workspaceStatus !== undefined || lineage.kind !== 'lineage') {
    return request
  }
  const workspaceStatus = readParentWorkspaceStatus(lineage.parent, store)
  return workspaceStatus ? { ...request, workspaceStatus } : request
}

function readParentWorkspaceStatus(
  parent: ResolvedWorkspaceParent,
  store: ParentWorkspaceStatusStore | null
): WorkspaceStatus | undefined {
  if (parent.type === 'folder') {
    return parent.folderWorkspace.workspaceStatus
  }
  const { worktree } = parent
  if (!store) {
    return worktree.workspaceStatus
  }
  // Why: the resolved parent comes from a short-lived snapshot that sidebar status edits do not
  // invalidate, so read the parent's persisted metadata instead.
  const hostId = getWorktreeExecutionHostId(worktree, store.getRepo(worktree.repoId))
  const legacyMeta = store.getWorktreeMeta(worktree.id)
  const meta =
    readWorktreeMetaForHost(store, worktree.id, hostId) ??
    (legacyMeta && (!legacyMeta.hostId || legacyMeta.hostId === hostId) ? legacyMeta : undefined)
  return meta ? meta.workspaceStatus : worktree.workspaceStatus
}
