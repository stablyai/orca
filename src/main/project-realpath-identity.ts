import { promises as fsPromises } from 'node:fs'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { getRepoExecutionHostId, isRepoOnCatalogHost } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { parseWslUncPath } from '../shared/wsl-paths'
import { areRuntimePathsEqual, toDetectedWorktree } from '../shared/worktree/ownership'

async function realpathKey(path: string): Promise<string | null> {
  const resolved = await fsPromises.realpath(path).catch(() => null)
  return resolved === null ? null : normalizeRuntimePathForComparison(resolved)
}

/** Resolve symlink aliases so the same checkout cannot be registered twice. */
export async function findProjectAtSameRealPath<T extends { path: string }>(
  projects: readonly T[],
  path: string
): Promise<T | null> {
  if (projects.length === 0) {
    return null
  }
  const resolved = await fsPromises.realpath(path).catch(() => null)
  if (!resolved) {
    return null
  }
  const target = normalizeRuntimePathForComparison(resolved)
  // A WSL share resolves only within its own distro; probing another one could boot it.
  const targetDistro = parseWslUncPath(resolved)?.distro.toLowerCase() ?? null
  const keys = await Promise.all(
    projects.map((project) => {
      const distro = parseWslUncPath(project.path)?.distro.toLowerCase()
      return distro !== undefined && distro !== targetDistro
        ? Promise.resolve(null)
        : realpathKey(project.path)
    })
  )
  const index = keys.indexOf(target)
  return index === -1 ? null : projects[index]
}

// Symbol-keyed so it survives row spreads but never JSON or IPC serialization.
const PROJECT_CHECKOUT_LOCATOR = Symbol('projectCheckoutLocator')

type ProjectCheckoutMarked = { [PROJECT_CHECKOUT_LOCATOR]?: string }

const checkoutRootDerivations = new Map<string, Promise<string | null>>()

/** One async root derivation per host and locator: a timeout cannot cancel realpath on a wedged mount. */
export function deriveProjectCheckoutRoot(repo: Repo): Promise<string | null> | null {
  if (isFolderRepo(repo) || !isRepoOnCatalogHost(repo) || parseWslUncPath(repo.path)) {
    return null
  }
  const key = `${getRepoExecutionHostId(repo)}\0${repo.path}`
  const inFlight = checkoutRootDerivations.get(key)
  if (inFlight) {
    return inFlight
  }
  const derivation = fsPromises
    .realpath(repo.path)
    .catch(() => null)
    .finally(() => {
      if (checkoutRootDerivations.get(key) === derivation) {
        checkoutRootDerivations.delete(key)
      }
    })
  checkoutRootDerivations.set(key, derivation)
  return derivation
}

/** Git lists physical checkout paths, so the scan's resolved root names the registered checkout. */
export function markProjectCheckout<T extends Pick<GitWorktreeInfo, 'path' | 'isBare'>>(
  repoPath: string,
  worktrees: T[],
  root: string | null
): T[] {
  if (!root || areRuntimePathsEqual(root, repoPath)) {
    return worktrees
  }
  return worktrees.map((worktree) =>
    !worktree.isBare &&
    !parseWslUncPath(worktree.path) &&
    !areRuntimePathsEqual(repoPath, worktree.path) &&
    areRuntimePathsEqual(root, worktree.path)
      ? { ...worktree, [PROJECT_CHECKOUT_LOCATOR]: repoPath }
      : worktree
  )
}

/** Copy boundaries that rebuild rows field by field keep the scan's proof. */
export function projectCheckoutMark(
  worktree: Pick<GitWorktreeInfo, 'path'> & ProjectCheckoutMarked
): ProjectCheckoutMarked {
  const locator = worktree[PROJECT_CHECKOUT_LOCATOR]
  return locator === undefined ? {} : { [PROJECT_CHECKOUT_LOCATOR]: locator }
}

/** Pure: a scan proved this row is the directory the saved locator names. */
export function isProjectCheckout(
  repo: Repo,
  worktree: Pick<GitWorktreeInfo, 'path'> & ProjectCheckoutMarked
): boolean {
  return (
    areRuntimePathsEqual(repo.path, worktree.path) ||
    worktree[PROJECT_CHECKOUT_LOCATOR] === repo.path
  )
}

export function toDetectedProjectWorktree(args: Parameters<typeof toDetectedWorktree>[0]) {
  return toDetectedWorktree({
    ...args,
    isSelectedCheckout: args.isSelectedCheckout ?? isProjectCheckout(args.repo, args.worktree)
  })
}
