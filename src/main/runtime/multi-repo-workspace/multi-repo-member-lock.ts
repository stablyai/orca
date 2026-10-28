import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorktreeLineageResolution } from '../runtime-worktree-lineage-resolution'
import type { RuntimeStore } from '../runtime-store-contract'

/** A worktree is locked iff some multi-repo member points at it; the record is the single source of truth. */
export function findMultiRepoMemberOwner(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>,
  worktreeId: string
): { folderWorkspaceId: string; memberId: string } | null {
  for (const workspace of store.getFolderWorkspaces?.() ?? []) {
    const member = workspace.multiRepo?.members.find((entry) => entry.worktreeId === worktreeId)
    if (member) {
      return { folderWorkspaceId: workspace.id, memberId: member.memberId }
    }
  }
  return null
}

export function assertWorktreeNotMultiRepoMember(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>,
  worktreeId: string
): void {
  if (findMultiRepoMemberOwner(store, worktreeId)) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_member_locked',
      'This workspace belongs to a multi-repo workspace. Use "Remove from workspace" first.'
    )
  }
}

export function isMultiRepoFolderParentKey(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>,
  parentWorkspaceKey: string
): boolean {
  return (store.getFolderWorkspaces?.() ?? []).some(
    (workspace) =>
      workspace.multiRepo !== undefined && folderWorkspaceKey(workspace.id) === parentWorkspaceKey
  )
}

/** Only the orchestrator attaches members; any other create under a multi-repo parent is created standalone. */
export function withoutMultiRepoParent(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'> | null,
  resolution: WorktreeLineageResolution
): WorktreeLineageResolution {
  if (
    !store ||
    resolution.kind !== 'lineage' ||
    resolution.parent.type !== 'folder' ||
    !isMultiRepoFolderParentKey(store, resolution.parent.workspaceKey)
  ) {
    return resolution
  }
  return {
    kind: 'none',
    warnings: [
      {
        code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
        message:
          'Created without a parent: projects are added to a multi-repo workspace only when it is created.'
      }
    ]
  }
}
