import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { isRepoRoot, listRepoWorktrees } from '../repo-worktrees'
import { getLocalRepos } from './filesystem-allowed-roots'
import { isDescendantOrEqual, normalizeExistingPath } from './filesystem-path-containment'

const registeredWorktreeRoots = new Set<string>()
const registeredWorktreeRootsByRepo = new Map<string, Set<string>>()
const registeredWorktreeRootRepoIds = new Set<string>()
let registeredWorktreeRootsDirty = true
let registeredWorktreeRootsRefresh: Promise<void> | null = null
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8

export function invalidateAuthorizedRootsCache(): void {
  registeredWorktreeRootsDirty = true
  // Why: dirty roots can't be trusted for auth short-circuits; fresh worktrees:list seeds safe per-repo roots before a full rebuild.
  registeredWorktreeRoots.clear()
  registeredWorktreeRootsByRepo.clear()
  registeredWorktreeRootRepoIds.clear()
}

export async function rebuildAuthorizedRootsCache(store: Store): Promise<void> {
  // Why: bounded parallelism keeps the Windows speedup without one git process per repo.
  // Why no realpath here: canonicalizing every root on invalidation would trigger macOS TCC prompts; handlers still canonicalize the target before any operation.
  const repos = getLocalRepos(store)
  const perProjectResults = await mapWithConcurrency(
    repos,
    AUTHORIZED_ROOTS_REBUILD_CONCURRENCY,
    async (repo) => {
      const roots: string[] = []
      try {
        roots.push(resolve(repo.path))

        for (const worktree of await listRepoWorktrees(repo)) {
          roots.push(resolve(worktree.path))
        }
      } catch (error) {
        // Why: one inaccessible repo (EACCES/EIO) must not break the whole rebuild and disable File Explorer/Quick Open for the rest; skip it.
        console.warn(`[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`, error)
      }
      return { repoId: repo.id, roots }
    }
  )

  registeredWorktreeRoots.clear()
  registeredWorktreeRootsByRepo.clear()
  registeredWorktreeRootRepoIds.clear()
  for (const { repoId, roots } of perProjectResults) {
    const normalizedRoots = new Set<string>()
    for (const root of roots) {
      normalizedRoots.add(root)
      registeredWorktreeRoots.add(root)
    }
    registeredWorktreeRootsByRepo.set(repoId, normalizedRoots)
    registeredWorktreeRootRepoIds.add(repoId)
  }
  registeredWorktreeRootsDirty = false
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrent: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(maxConcurrent, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index])
      }
    })
  )
  return results
}

export function registerWorktreeRootsForRepo(
  store: Store,
  repoId: string,
  worktreeRoots: string[]
): void {
  const localRepoIds = new Set(getLocalRepos(store).map((repo) => repo.id))
  for (const registeredRepoId of registeredWorktreeRootsByRepo.keys()) {
    if (!localRepoIds.has(registeredRepoId)) {
      registeredWorktreeRootsByRepo.delete(registeredRepoId)
      registeredWorktreeRootRepoIds.delete(registeredRepoId)
    }
  }

  if (!localRepoIds.has(repoId)) {
    refreshRegisteredWorktreeRoots()
    registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
    return
  }

  registeredWorktreeRootsByRepo.set(repoId, new Set(worktreeRoots.map((root) => resolve(root))))
  registeredWorktreeRootRepoIds.add(repoId)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
}

export async function ensureAuthorizedRootsCache(store: Store): Promise<void> {
  if (!registeredWorktreeRootsDirty) {
    return
  }
  if (!registeredWorktreeRootsRefresh) {
    registeredWorktreeRootsRefresh = rebuildAuthorizedRootsCache(store).finally(() => {
      registeredWorktreeRootsRefresh = null
    })
  }
  await registeredWorktreeRootsRefresh
}

/**
 * Resolve and verify that a worktree path belongs to a registered repo.
 *
 * Why not resolveAuthorizedPath: linked worktrees can live outside repo/workspace roots; git trusts exact `git worktree list` registration, not containment.
 */
export async function resolveRegisteredWorktreePath(
  worktreePath: string,
  store: Store
): Promise<string> {
  // Reject malformed paths (null byte) early to prevent probing via realpath.
  if (!worktreePath || worktreePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }

  const resolvedTarget = resolve(worktreePath)
  if (registeredWorktreeRoots.has(resolvedTarget) || isRepoRoot(store.getRepos(), resolvedTarget)) {
    return resolvedTarget
  }

  if (registeredWorktreeRootsDirty) {
    await ensureAuthorizedRootsCache(store)
  }

  if (registeredWorktreeRoots.has(resolvedTarget)) {
    return resolvedTarget
  }

  // Resolve symlinks only after the cheap registered-root check: on macOS realpath() can trigger TCC prompts.
  const normalizedTarget = await normalizeExistingPath(resolvedTarget)
  if (registeredWorktreeRoots.has(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error('Access denied: unknown repository or worktree path')
}

function refreshRegisteredWorktreeRoots(): void {
  registeredWorktreeRoots.clear()
  for (const roots of registeredWorktreeRootsByRepo.values()) {
    for (const root of roots) {
      registeredWorktreeRoots.add(root)
    }
  }
}

function allLocalRepoRootsRegistered(localRepoIds: Set<string>): boolean {
  for (const repoId of localRepoIds) {
    if (!registeredWorktreeRootRepoIds.has(repoId)) {
      return false
    }
  }
  return true
}

export function isRegisteredWorktreePath(targetPath: string): boolean {
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root)) {
      return true
    }
  }
  return false
}

export async function isPathAllowedByCanonicalRegisteredRoot(
  targetPath: string,
  sourcePath: string | undefined
): Promise<boolean> {
  if (!sourcePath) {
    return false
  }
  const textualRoot = findRegisteredWorktreeRoot(sourcePath)
  if (!textualRoot) {
    return false
  }
  const canonicalRoot = await normalizeExistingPath(textualRoot)
  if (!isDescendantOrEqual(targetPath, canonicalRoot)) {
    return false
  }
  // Why: #1524 stopped realpath'ing every root (macOS privacy prompts); cache only the actively-accessed root so /var→/private/var aliases resolve.
  registeredWorktreeRoots.add(canonicalRoot)
  return true
}

function findRegisteredWorktreeRoot(targetPath: string): string | null {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    if (!isDescendantOrEqual(targetPath, root)) {
      continue
    }
    if (!bestRoot || root.length > bestRoot.length) {
      bestRoot = root
    }
  }
  return bestRoot
}
