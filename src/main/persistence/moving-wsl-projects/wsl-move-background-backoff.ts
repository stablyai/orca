// Background writers retry naturally; quietly defer moving/moved local rows using host and path evidence.
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

/** Folder keys lack paths, so callers must supply the folder path for fallback checks. */
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
