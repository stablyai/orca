import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { isFolderRepo } from '../../../shared/repo-kind'
import { repoIdForHostLocalProjectId } from '../../../shared/project-host-setup-projection'
import {
  getRepoIdFromWorktreeId,
  getRepoMainWorktreeId,
  rewriteWorktreeIdPath,
  splitWorktreeIdForFilesystem
} from '../../../shared/worktree/id'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getResolvedFolderWorkspacePathStatus } from '../../project-groups/folder-workspace-path-status'
import type { Store } from '../../persistence/loading-store/store'

export type FolderProjectRepointResult =
  | { outcome: 'repointed'; repo: Repo }
  | { outcome: 'not-applicable' }
  | { outcome: 'refused'; reason: string }

type RepointStore = Pick<
  Store,
  | 'getRepos'
  | 'updateRepo'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeLineage'
  | 'migrateWorktreeIdentity'
>

/**
 * A moved folder project has no way back: re-import cannot target it (host-local project ids are
 * rejected as identity mismatches) and would instead add a duplicate project, leaving the stale row
 * and its workspaces behind. When an import names that project and its recorded folder is really
 * gone, repoint the existing row so identity, workspaces and sessions survive the move (#30807).
 */
export async function repointMovedFolderProject(
  store: RepointStore,
  args: { projectId: string; folderPath: string; kind?: 'git' | 'folder' }
): Promise<FolderProjectRepointResult> {
  const repoId = repoIdForHostLocalProjectId(args.projectId)
  const newPath = args.folderPath.trim()
  if (!repoId || !newPath || args.kind === 'git') {
    return { outcome: 'not-applicable' }
  }
  const repo = findLocalFolderRepo(store, repoId)
  if (!repo) {
    return { outcome: 'not-applicable' }
  }
  if (normalizeRuntimePathForComparison(newPath) === normalizeRuntimePathForComparison(repo.path)) {
    // Same location; ordinary import dedupe already resolves it.
    return { outcome: 'not-applicable' }
  }
  // Only a folder that is really gone turns an import into a repoint; an unreadable volume
  // (e.g. a stopped WSL distro) must keep the normal import flow.
  const oldStatus = await getResolvedFolderWorkspacePathStatus(
    { folderPath: repo.path },
    LOCAL_EXECUTION_HOST_ID
  )
  if (oldStatus.exists || oldStatus.reason !== 'missing') {
    return { outcome: 'not-applicable' }
  }
  const newStatus = await getResolvedFolderWorkspacePathStatus(
    { folderPath: newPath },
    LOCAL_EXECUTION_HOST_ID
  )
  if (!newStatus.exists) {
    return {
      outcome: 'refused',
      reason:
        newStatus.reason === 'not-directory'
          ? `${newPath} exists, but it is not a folder.`
          : `Orca cannot find ${newPath}. Choose the folder's new location.`
    }
  }
  // The awaits above can yield; a row that changed underneath us must not be repointed blind.
  const current = findLocalFolderRepo(store, repoId)
  if (!current || current.path !== repo.path) {
    return { outcome: 'not-applicable' }
  }
  const newPathKey = normalizeRuntimePathForComparison(newPath)
  if (
    store
      .getRepos()
      .some(
        (entry) =>
          !entry.connectionId && normalizeRuntimePathForComparison(entry.path) === newPathKey
      )
  ) {
    return { outcome: 'refused', reason: `Another project already uses this folder: ${newPath}` }
  }
  migrateFolderProjectWorktreeIds(store, current, newPath)
  const updated = store.updateRepo(current, { path: newPath })
  return updated ? { outcome: 'repointed', repo: updated } : { outcome: 'not-applicable' }
}

function findLocalFolderRepo(store: Pick<Store, 'getRepos'>, repoId: string): Repo | null {
  const repo = store
    .getRepos()
    .find(
      (entry) => entry.id === repoId && getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID
    )
  return repo && isFolderRepo(repo) ? repo : null
}

/** Worktree ids embed the folder path, so re-key each one the project owns onto the new path. */
function migrateFolderProjectWorktreeIds(store: RepointStore, repo: Repo, newPath: string): void {
  const candidates = new Set<string>([getRepoMainWorktreeId(repo)])
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    candidates.add(worktreeId)
  }
  for (const worktreeId of Object.keys(store.getAllWorktreeLineage())) {
    candidates.add(worktreeId)
  }
  for (const worktreeId of candidates) {
    if (getRepoIdFromWorktreeId(worktreeId) !== repo.id) {
      continue
    }
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed || !isPathInsideOrEqual(repo.path, parsed.worktreePath)) {
      continue
    }
    const nextId = rewriteWorktreeIdPath(worktreeId, (folderPath) => {
      const suffix = relativePathInsideRoot(repo.path, folderPath)
      return suffix === null ? folderPath : suffix ? `${newPath}/${suffix}` : newPath
    })
    if (nextId !== worktreeId) {
      store.migrateWorktreeIdentity(
        hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID }),
        nextId
      )
    }
  }
}
