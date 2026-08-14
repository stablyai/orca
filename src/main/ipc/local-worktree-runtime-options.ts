import { resolve } from 'node:path'
import type { Store } from '../persistence'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getCandidateLocalWorktreePaths(
  worktreePath: string,
  resolvedWorktreePath: string
): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparableLocalPath))
}

function hasRegisteredWorktreeMetaForRepo(
  store: Store,
  repoId: string,
  candidatePaths: Set<string>
): boolean {
  const worktreeMeta =
    typeof store.getAllWorktreeMeta === 'function' ? store.getAllWorktreeMeta() : {}
  for (const worktreeId of Object.keys(worktreeMeta)) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId === repoId && candidatePaths.has(comparableLocalPath(parsed.worktreePath))) {
      return true
    }
  }
  return false
}

export function getLocalRepoForRegisteredWorktree(
  store: Store,
  worktreePath: string,
  resolvedWorktreePath: string
): Repo | undefined {
  if (typeof store.getRepos !== 'function') {
    return undefined
  }

  const candidatePaths = getCandidateLocalWorktreePaths(worktreePath, resolvedWorktreePath)
  return store
    .getRepos()
    .find(
      (repo) =>
        !repo.connectionId &&
        (candidatePaths.has(comparableLocalPath(repo.path)) ||
          hasRegisteredWorktreeMetaForRepo(store, repo.id, candidatePaths))
    )
}

/** Git options for a repo already resolved by `getLocalRepoForRegisteredWorktree`,
 *  so a caller needing both does not walk every repo's worktree meta twice. */
export function getLocalGitOptionsForRepo(
  store: Store,
  repo: Repo | undefined
): LocalProjectWorktreeGitOptions {
  if (!repo || typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }
  // Why: file discovery must use the same resolved runtime as project git,
  // terminals, and agents even when the worktree path is a Windows path.
  return getLocalProjectWorktreeGitOptions(store, repo)
}

export function getLocalGitOptionsForRegisteredWorktree(
  store: Store,
  worktreePath: string,
  resolvedWorktreePath: string
): LocalProjectWorktreeGitOptions {
  if (typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }

  return getLocalGitOptionsForRepo(
    store,
    getLocalRepoForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  )
}
