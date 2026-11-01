import { realpath } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { isRepoOnCatalogHost } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { parseWslUncPath } from '../shared/wsl-paths'
import { areRuntimePathsEqual, toDetectedWorktree } from '../shared/worktree/ownership'
import { resolveRealPathSync } from './git/repo-git-marker-scan'

async function realpathKey(path: string): Promise<string | null> {
  try {
    return normalizeRuntimePathForComparison(await realpath(path))
  } catch {
    return null
  }
}

/** Resolve symlink aliases so the same checkout cannot be registered twice. */
export async function findProjectAtSameRealPath<T extends { path: string }>(
  projects: readonly T[],
  path: string
): Promise<T | null> {
  if (projects.length === 0) {
    return null
  }
  const target = await realpathKey(path)
  if (!target) {
    return null
  }
  const keys = await Promise.all(projects.map((project) => realpathKey(project.path)))
  const index = keys.indexOf(target)
  return index === -1 ? null : projects[index]
}

export function isProjectCheckout(
  repo: Repo,
  worktree: Pick<GitWorktreeInfo, 'path' | 'isMainWorktree' | 'isBare'>
): boolean {
  if (areRuntimePathsEqual(repo.path, worktree.path)) {
    return true
  }
  if (
    isFolderRepo(repo) ||
    !worktree.isMainWorktree ||
    worktree.isBare ||
    !isRepoOnCatalogHost(repo) ||
    parseWslUncPath(repo.path) ||
    parseWslUncPath(worktree.path)
  ) {
    return false
  }
  // Keep published workspace IDs; only selection compares filesystem identity.
  const root = resolveRealPathSync(repo.path)
  const checkout = resolveRealPathSync(worktree.path)
  return root !== null && checkout !== null && areRuntimePathsEqual(root, checkout)
}

export function toDetectedProjectWorktree(args: Parameters<typeof toDetectedWorktree>[0]) {
  return toDetectedWorktree({
    ...args,
    isSelectedCheckout: args.isSelectedCheckout ?? isProjectCheckout(args.repo, args.worktree)
  })
}
