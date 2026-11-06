import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'

type WorktreeMetaLabel = { displayName?: string }

/** The stored facts needed to describe a workspace the local catalog cannot resolve. */
export type StoredWorkspaceContextStore = {
  getFolderWorkspaces?: () => readonly {
    id: string
    name: string
    folderPath: string
    executionHostId?: ExecutionHostId | null
  }[]
  getWorktreeMeta?: (worktreeId: string) => WorktreeMetaLabel | null | undefined
  getWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId
  ) => WorktreeMetaLabel | undefined
  getRepos?: () => readonly {
    id: string
    displayName: string
    connectionId?: string | null
    executionHostId?: ExecutionHostId | null
  }[]
}

/**
 * Describe an active workspace from persisted rows. A remote worktree is absent from the local
 * catalog, but its id, path and display name are still what a workspace-scoped plugin needs.
 * Host-qualified ids keep two hosts' copies of the same id apart.
 */
export function resolveStoredWorkspaceContext(
  store: StoredWorkspaceContextStore | null | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId
): { worktreeId: string; path: string; branch: string; displayName: string } | null {
  const scopedId =
    hostId && hostId !== LOCAL_EXECUTION_HOST_ID
      ? composeWorktreeHostIdentity(hostId, worktreeId)
      : worktreeId
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = store
      ?.getFolderWorkspaces?.()
      .find(
        (candidate) =>
          candidate.id === scope.folderWorkspaceId &&
          (!hostId || (candidate.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === hostId)
      )
    return folder
      ? {
          worktreeId: scopedId,
          path: folder.folderPath,
          branch: '',
          displayName: nonEmpty(folder.name, folder.folderPath)
        }
      : null
  }
  const id = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const parsed = splitWorktreeIdForFilesystem(id)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return null
  }
  const repo = store
    ?.getRepos?.()
    .find(
      (candidate) =>
        candidate.id === parsed.repoId && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
  const meta = hostId ? store?.getWorktreeMetaForHost?.(id, hostId) : store?.getWorktreeMeta?.(id)
  if (!meta && !repo) {
    return null
  }
  return {
    worktreeId: scopedId,
    path: parsed.worktreePath,
    branch: '',
    displayName: nonEmpty(meta?.displayName, repo?.displayName, parsed.worktreePath)
  }
}

/** First nonempty, trimmed label; an empty final value stays empty. */
function nonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? ''
}
