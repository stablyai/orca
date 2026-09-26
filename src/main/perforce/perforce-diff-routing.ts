import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolvePerforceBackend } from './perforce-ssh-backend'

/** Folder project (local or SSH) whose root is `worktreePath` or contains `filePath`. */
export function findFolderRepoAt(
  store: Store,
  connectionId: string | null | undefined,
  path: string,
  options: { contains: boolean }
): Repo | undefined {
  const target = normalizeRuntimePathForComparison(path)
  return store.getRepos().find((repo) => {
    if ((repo.connectionId ?? null) !== (connectionId ?? null) || !isFolderRepo(repo)) {
      return false
    }
    const root = normalizeRuntimePathForComparison(repo.path)
    return target === root || (options.contains && target.startsWith(`${root}/`))
  })
}

/** Perforce workspaces are registered as folders, so their diffs come from p4 instead of git; null means not Perforce. */
export async function getPerforceFolderDiff(
  store: Store,
  connectionId: string | null | undefined,
  worktreePath: string,
  filePath: string
): Promise<GitDiffResult | null> {
  if (!findFolderRepoAt(store, connectionId, worktreePath, { contains: false })) {
    return null
  }
  const backend = resolvePerforceBackend(connectionId)
  return (await backend.detect(worktreePath)).isWorkspace
    ? backend.diff(worktreePath, filePath)
    : null
}
