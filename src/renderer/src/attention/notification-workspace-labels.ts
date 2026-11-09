import type { useAppStore } from '../store/index'
import { getIndexedRepoMap } from '../store/repos/repository-catalog-index'
import { getIndexedWorktreesById } from '../store/slices/worktrees/listing/worktree-catalog-index'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../store/slices/worktrees/listing/worktree-host-ownership'
import { getResolvedExecutionHostIdForWorktree } from '../lib/resolved-worktree-execution-host'
import { getActiveWorkspaceExecutionHostId } from '../lib/workspace/ownership/active-workspace-host'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '../lib/workspace/ownership/worktree-runtime-owner-index'
import {
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner
} from '../lib/workspace/ownership/repo-owner-index'
import { getCatalogOwnerHostId } from '../lib/workspace/ownership/workspace-catalog-owner-index'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../store/workspaces/catalog/workspace-record-fields'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

/** Resolve the workspace’s owning host: repoId::path omits host and can collide. Hydrated ownership must prove one before naming the workspace (STA-4343). */
function findWorktreeRowOnItsOwnHost(
  state: StoreSnapshot,
  worktreeId: string
): { worktree: Worktree | undefined; hostId: ExecutionHostId | null } {
  const rows = getIndexedWorktreesById(selectWorktreesByRepo(state), worktreeId)
  if (rows.length <= 1) {
    return { worktree: rows[0], hostId: null }
  }
  const hostId =
    getActiveWorkspaceExecutionHostId(state, worktreeId) ??
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!hostId) {
    return { worktree: undefined, hostId: null }
  }
  // Colliding rows share the id's repo prefix, so any row names the repo to scope against.
  const matchOptions = worktreeHostMatchOptions(state, rows[0].repoId, hostId)
  return { worktree: rows.find((row) => worktreeMatchesHost(row, hostId, matchOptions)), hostId }
}

/** Name the project only with a unique repo owner; repo IDs can collide across hosts even when workspace paths differ. */
function findNotificationRepo(
  state: StoreSnapshot,
  worktreeId: string,
  repoId: string,
  hostId: ExecutionHostId | null
): Repo | undefined {
  // One owner for the id means the id-keyed map already names it, at no extra cost.
  if (resolveIndexedRepoOwner(state.repos, repoId).kind !== 'ambiguous') {
    return getIndexedRepoMap(state.repos).get(repoId)
  }
  const owningHost = hostId ?? getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!owningHost) {
    return undefined
  }
  return findIndexedRepoOwnerForHost(state.repos, repoId, owningHost) ?? undefined
}

export function getNotificationWorkspaceLabels(
  state: StoreSnapshot,
  workspaceId: string,
  terminalTitle?: string
): { repoLabel?: string; worktreeLabel: string } {
  const scope = parseWorkspaceKey(workspaceId)
  const fallback = terminalTitle?.trim() || 'workspace'
  if (scope?.type === 'folder') {
    const folder = findIndexedFolderWorkspaceOwner(
      selectFolderWorkspaces(state),
      scope.folderWorkspaceId
    )
    // The group ID is only unique per host, so qualify it with the folder's own host.
    const group =
      folder &&
      findIndexedProjectGroupOwner(
        state.projectGroups,
        folder.projectGroupId,
        getCatalogOwnerHostId(folder)
      )
    return { repoLabel: group?.name, worktreeLabel: folder?.name || fallback }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const { worktree, hostId } = findWorktreeRowOnItsOwnHost(state, worktreeId)
  const repo = worktree
    ? findNotificationRepo(state, worktreeId, worktree.repoId, hostId)
    : undefined
  return {
    repoLabel: repo?.displayName,
    worktreeLabel: worktree?.displayName || worktree?.branch || fallback
  }
}
