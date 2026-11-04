import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
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
