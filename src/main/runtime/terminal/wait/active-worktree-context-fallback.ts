import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
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
 * Describe an active remote workspace from persisted rows. A remote worktree is absent from the
 * local catalog, but its id, path and display name are still what a workspace-scoped plugin needs.
 * The id stays raw: terminal listing and agent-status rows key on the raw id, and the host filter
 * below already picks the right copy of a twin id. Local rows never fall back, so a stale focus
 * on a removed local worktree stays null instead of naming a workspace that no longer exists.
 */
export function resolveStoredWorkspaceContext(
  store: StoredWorkspaceContextStore | null | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId
): { worktreeId: string; path: string; branch: string; displayName: string } | null {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = store
      ?.getFolderWorkspaces?.()
      .find(
        (candidate) =>
          candidate.id === scope.folderWorkspaceId &&
          (!hostId || (candidate.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === hostId)
      )
    return folder && (folder.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID
      ? {
          worktreeId,
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
  // Without a known remote host the row may be a removed local worktree; never guess.
  const rowHostId = hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  if ((!meta && !repo) || !rowHostId || rowHostId === LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  return {
    worktreeId: id,
    path: parsed.worktreePath,
    branch: '',
    displayName: nonEmpty(meta?.displayName, repo?.displayName, parsed.worktreePath)
  }
}

/** First nonempty, trimmed label; an empty final value stays empty. */
function nonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? ''
}
