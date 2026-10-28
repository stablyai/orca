import type { FolderWorkspace } from '../shared/folder-workspace-types'

type MultiRepoPruneStore = {
  getFolderWorkspaces?: () => FolderWorkspace[]
  updateFolderWorkspace?: (id: string, updates: Pick<FolderWorkspace, 'multiRepo'>) => unknown
}

/** A worktree removed by any path takes its multi-repo member with it; a detached entry is dropped too. */
export function pruneMultiRepoMemberForWorktree(
  store: MultiRepoPruneStore,
  worktreeId: string
): void {
  for (const workspace of store.getFolderWorkspaces?.() ?? []) {
    const multiRepo = workspace.multiRepo
    if (!multiRepo) {
      continue
    }
    const members = multiRepo.members.filter((member) => member.worktreeId !== worktreeId)
    const detached = (multiRepo.detachedMembers ?? []).filter(
      (member) => member.worktreeId !== worktreeId
    )
    if (
      members.length === multiRepo.members.length &&
      detached.length === (multiRepo.detachedMembers ?? []).length
    ) {
      continue
    }
    const { detachedMembers: _previous, ...rest } = multiRepo
    store.updateFolderWorkspace?.(workspace.id, {
      multiRepo: { ...rest, members, ...(detached.length > 0 ? { detachedMembers: detached } : {}) }
    })
  }
}
