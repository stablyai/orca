/**
 * Background writers (first-work renames, scan pruning, backfills) back off quietly from a project a
 * WSL move is taking, or one the WSL host now owns: no throw, no data change. They are all periodic
 * or event-driven, so they retry on their own once the move settles.
 *
 * Each check names the row's host: a move only takes local rows, and the same id on another host is
 * a different project. The row's own path stands in for the store when the journal is unreadable.
 */
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import {
  isLocalWslMoveRow,
  isWslMoveProjectBlocked,
  isWslMoveProjectFenced,
  isWslMoveSourceHost,
  wslMoveProjectRefForWorkspace
} from './wsl-move-scope-guard'

type HostedRow = { connectionId?: string | null; executionHostId?: string | null }

export type WslMoveRepoRow = HostedRow & { id: string; path: string }

export type WslMoveFolderWorkspaceRow = HostedRow & { id: string; folderPath: string }

function repoStore(repo: WslMoveRepoRow) {
  return { getRepo: (id: string) => (id === repo.id ? repo : undefined) }
}

export function isWslMoveRepoBlocked(repo: WslMoveRepoRow): boolean {
  if (!isWslMoveSourceHost(getRepoExecutionHostId(repo))) {
    return false
  }
  return isWslMoveProjectBlocked(repoStore(repo), { repoId: repo.id })
}

/** `moving` while a move is taking the repo, `owned` once the WSL host runs it, else null. */
export function wslMoveRepoBackoff(repo: WslMoveRepoRow): 'moving' | 'owned' | null {
  if (!isWslMoveRepoBlocked(repo)) {
    return null
  }
  return isWslMoveProjectFenced(repoStore(repo), { repoId: repo.id }) ? 'moving' : 'owned'
}

export function isWslMoveFolderWorkspaceBlocked(folder: WslMoveFolderWorkspaceRow): boolean {
  if (!isLocalWslMoveRow(folder)) {
    return false
  }
  const store = {
    getRepo: () => undefined,
    getFolderWorkspace: (id: string) => (id === folder.id ? folder : undefined)
  }
  return isWslMoveProjectBlocked(store, { folderWorkspaceId: folder.id })
}

/**
 * For a worktree known only by id and host, such as a resolved worktree or its metadata row.
 * A folder workspace key carries no path, so callers holding one pass its folder path.
 */
export function isWslMoveWorktreeBlocked(
  worktreeId: string,
  hostId: string | null | undefined,
  worktreePath?: string
): boolean {
  if (!isLocalWslMoveRow({ executionHostId: hostId })) {
    return false
  }
  const path = worktreePath ?? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  const row = path === undefined ? undefined : { path, folderPath: path }
  const store = { getRepo: () => row, getFolderWorkspace: () => row }
  return isWslMoveProjectBlocked(store, wslMoveProjectRefForWorkspace(worktreeId))
}
