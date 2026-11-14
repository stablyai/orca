import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getActiveSidebarWorkspaceId, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { worktreeMetaIdentityKey } from '../../../../shared/worktree/identity'

type WorktreeMetaLabel = { displayName?: string; instanceId?: string; hostId?: ExecutionHostId }
export type ActiveWorkspaceContext = {
  worktreeId: string
  /** Host-qualified identity key; absent for folders and rows known only from storage. */
  identityKey?: string
  path: string
  branch: string
  displayName: string
}

/** The scoped key is set for folder workspaces and remote focus; the legacy id alone misses those. */
export function activeSessionWorkspaceId(
  session:
    | { activeWorkspaceKey?: string | null; activeWorktreeId?: string | null }
    | null
    | undefined
): string | null {
  return getActiveSidebarWorkspaceId(
    session?.activeWorkspaceKey ?? null,
    session?.activeWorktreeId ?? null
  )
}

/**
 * Catalog lookups for the focused id, in order. A remote stamp stays scoped so a paired-server
 * focus never borrows a local twin's row. A local (or unstamped) focus keeps its pre-host-field
 * answer: a stale local stamp, e.g. after the repo moved hosts, must not turn into null.
 */
export function activeWorkspaceSelectorScopes(
  hostId: ExecutionHostId | undefined
): ({ requiredHostId: ExecutionHostId } | undefined)[] {
  if (hostId === undefined) {
    return [undefined]
  }
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? [{ requiredHostId: hostId }, undefined]
    : [{ requiredHostId: hostId }]
}

/** What `MobileRelayHostCatalog.workspaceContext` answers: a paired server's listed workspace. */
export type PairedWorkspaceContextSource = {
  workspaceContext(
    hostId: ExecutionHostId,
    worktreeId: string
  ): Promise<ActiveWorkspaceContext | null>
}

/**
 * The focused workspace the local catalog could not resolve. A paired server's workspace lives in
 * that server's store, so it comes from the server rows the desktop holds; anything else, and a
 * server the desktop cannot answer for, falls back to the desktop's stored rows.
 */
export async function resolveRemoteWorkspaceContext(
  store: StoredWorkspaceContextStore | null | undefined,
  paired: PairedWorkspaceContextSource | null,
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<ActiveWorkspaceContext | null> {
  if (paired && hostId && parseExecutionHostId(hostId)?.kind === 'runtime') {
    const context = await paired.workspaceContext(hostId, worktreeId).catch(() => null)
    if (context) {
      return context
    }
  }
  return resolveStoredWorkspaceContext(store, worktreeId, hostId)
}

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
): ActiveWorkspaceContext | null {
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
  // Host-qualified: a same-id row of another host never lends this workspace its identity.
  const identityKey = worktreeMetaIdentityKey(id, store?.getWorktreeMetaForHost?.(id, rowHostId))
  return {
    worktreeId: id,
    ...(identityKey ? { identityKey } : {}),
    path: parsed.worktreePath,
    branch: '',
    displayName: nonEmpty(meta?.displayName, repo?.displayName, parsed.worktreePath)
  }
}

/** First nonempty, trimmed label; an empty final value stays empty. */
function nonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? ''
}
