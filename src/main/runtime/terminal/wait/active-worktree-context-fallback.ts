import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'

/** The stored facts needed to describe a workspace the local catalog cannot resolve. */
export type StoredWorkspaceContextStore = {
  getFolderWorkspaces?: () => readonly {
    id: string
    name: string
    folderPath: string
  }[]
  getWorktreeMeta?: (worktreeId: string) => { displayName?: string } | null | undefined
  getRepos?: () => readonly { id: string; displayName: string }[]
}

/**
 * Describe an active workspace from persisted rows. A remote worktree is absent from the local
 * catalog, but its id, path and display name are still what a workspace-scoped plugin needs.
 */
export function resolveStoredWorkspaceContext(
  store: StoredWorkspaceContextStore | null | undefined,
  worktreeId: string
): { worktreeId: string; path: string; branch: string; displayName: string } | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = store
      ?.getFolderWorkspaces?.()
      .find((candidate) => candidate.id === scope.folderWorkspaceId)
    return folder
      ? { worktreeId, path: folder.folderPath, branch: '', displayName: folder.name }
      : null
  }
  const id = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const parsed = splitWorktreeIdForFilesystem(id)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return null
  }
  const meta = store?.getWorktreeMeta?.(id)
  const repo = store?.getRepos?.().find((candidate) => candidate.id === parsed.repoId)
  if (!meta && !repo) {
    return null
  }
  return {
    worktreeId: id,
    path: parsed.worktreePath,
    branch: '',
    displayName: meta?.displayName ?? repo?.displayName ?? parsed.worktreePath
  }
}
