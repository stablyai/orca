import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { getErrorCode } from '../git/worktree-operation-options'
import type { Store } from '../persistence'
import { isRepoRoot, listRepoWorktreeGraph } from '../repo-worktrees'
import { getLocalRepos } from './filesystem-allowed-roots'
import { isDescendantOrEqual, normalizeExistingPath } from './filesystem-path-containment'

const registeredWorktreeRoots = new Set<string>()
const registeredWorktreeRootsByRepo = new Map<string, Set<string>>()
/**
 * Roots Git confirmed by direct read while `git worktree list` could not see them.
 *
 * Why a layer of its own: everything in `registeredWorktreeRootsByRepo` is derived from the listing,
 * so a rebuild recomputes it from the very listing that failed and would re-deny a worktree the
 * create just recovered. This layer survives rebuilds and is pruned only on evidence (#16520).
 */
const createdWorktreeRootsByRepo = new Map<string, Set<string>>()
/** A recovered create is rare (Git's listing must be broken); cap the layer so it can never grow unbounded. */
const CREATED_WORKTREE_ROOTS_MAX = 64
/** The prune runs inside filesystem-auth resolution, so a hung mount must not stall it. */
const CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS = 1_000
const registeredWorktreeRootRepoIds = new Set<string>()
const registeredWorktreeRootsRevisionByRepo = new Map<string, number>()
let registeredWorktreeRootsRevisionSequence = 0
let registeredWorktreeRootsBaseRevision = 0
let registeredWorktreeRootsDirty = true
let registeredWorktreeRootsRefresh: Promise<void> | null = null
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8

export function invalidateAuthorizedRootsCache(): void {
  registeredWorktreeRootsDirty = true
  // Why: dirty roots can't be trusted for auth short-circuits; fresh worktrees:list seeds safe per-repo roots before a full rebuild.
  registeredWorktreeRoots.clear()
  registeredWorktreeRootsByRepo.clear()
  registeredWorktreeRootRepoIds.clear()
  // The recovered layer is deliberately not cleared: repo mutations are frequent, and dropping it here
  // would re-deny a recovered worktree every time an unrelated repo is added or removed.
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsBaseRevision = ++registeredWorktreeRootsRevisionSequence
  registeredWorktreeRootsRevisionByRepo.clear()
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

        for (const worktree of await listRepoWorktreeGraph(repo)) {
          roots.push(resolve(worktree.path))
        }
      } catch (error) {
        // Why: one inaccessible repo (EACCES/EIO) must not break the whole rebuild and disable File Explorer/Quick Open for the rest; skip it.
        console.warn(`[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`, error)
        return { repoId: repo.id, roots, listingFailed: true }
      }
      return { repoId: repo.id, roots, listingFailed: false }
    }
  )
  await pruneCreatedWorktreeRoots(perProjectResults, new Set(repos.map((repo) => repo.id)))

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
  for (const roots of createdWorktreeRootsByRepo.values()) {
    for (const root of roots) {
      registeredWorktreeRoots.add(root)
    }
  }
  registeredWorktreeRootsDirty = false
  registeredWorktreeRootsBaseRevision = ++registeredWorktreeRootsRevisionSequence
  registeredWorktreeRootsRevisionByRepo.clear()
}

/**
 * Retire recovered roots on evidence: the listing can see the worktree again, or it is gone from disk.
 *
 * Nothing is retired for want of evidence. A repo whose listing threw is left untouched, and so is a
 * root whose probe hangs or errors for any reason but ENOENT — a dead mount fails the listing and the
 * probe alike, and pruning on that would revoke the worktree in the very outage this layer exists for.
 */
async function pruneCreatedWorktreeRoots(
  results: readonly { repoId: string; roots: string[]; listingFailed: boolean }[],
  localRepoIds: Set<string>
): Promise<void> {
  const listedByRepo = new Map(
    results.filter((result) => !result.listingFailed).map((r) => [r.repoId, new Set(r.roots)])
  )
  const probes: Promise<void>[] = []
  for (const [repoId, roots] of createdWorktreeRootsByRepo) {
    if (!localRepoIds.has(repoId)) {
      createdWorktreeRootsByRepo.delete(repoId)
      continue
    }
    const listed = listedByRepo.get(repoId)
    if (!listed) {
      continue
    }
    for (const root of roots) {
      if (listed.has(root)) {
        roots.delete(root)
        continue
      }
      // Probe in parallel: a repo may hold up to CREATED_WORKTREE_ROOTS_MAX roots, and serial
      // timeouts would multiply into a rebuild stall of their own.
      probes.push(
        isRootGoneFromDisk(root).then((gone) => {
          if (gone) {
            roots.delete(root)
          }
        })
      )
    }
  }
  await Promise.all(probes)
  for (const [repoId, roots] of createdWorktreeRootsByRepo) {
    if (roots.size === 0) {
      createdWorktreeRootsByRepo.delete(repoId)
    }
  }
}

/** Only a definitive ENOENT counts as removal; the timeout unblocks the rebuild but cannot cancel the syscall. */
async function isRootGoneFromDisk(targetPath: string): Promise<boolean> {
  const probe = stat(targetPath).then(
    () => false,
    (error: unknown) => getErrorCode(error) === 'ENOENT'
  )
  return withTimeout(probe, CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS, false)
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
      registeredWorktreeRootsRevisionByRepo.set(
        registeredRepoId,
        ++registeredWorktreeRootsRevisionSequence
      )
    }
  }

  if (!localRepoIds.has(repoId)) {
    refreshRegisteredWorktreeRoots()
    registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
    return
  }

  registeredWorktreeRootsByRepo.set(repoId, new Set(worktreeRoots.map((root) => resolve(root))))
  registeredWorktreeRootRepoIds.add(repoId)
  registeredWorktreeRootsRevisionByRepo.set(repoId, ++registeredWorktreeRootsRevisionSequence)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
}

/**
 * Authorize one worktree root that Git confirmed by direct read but could not list.
 *
 * Why not `registerWorktreeRootsForRepo`: that replaces the repo's set, and a create recovered without
 * a listing has no full set to put there. The root goes in the recovered layer instead, so the next
 * rebuild cannot drop it while Git's listing is still broken (#16520).
 */
export function registerCreatedWorktreeRoot(
  store: Store,
  repoId: string,
  worktreeRoot: string
): void {
  const localRepoIds = new Set(getLocalRepos(store).map((repo) => repo.id))
  if (!localRepoIds.has(repoId)) {
    return
  }
  const roots = createdWorktreeRootsByRepo.get(repoId) ?? new Set<string>()
  const root = resolve(worktreeRoot)
  if (!roots.has(root) && roots.size >= CREATED_WORKTREE_ROOTS_MAX) {
    // Refuse rather than evict: dropping an already-authorized root denies a worktree the user is
    // using, while declining this one only leaves the new create as unauthorized as it is today.
    console.warn(
      `[filesystem-auth] recovered-root layer full for repo ${repoId}; not authorizing ${root}`
    )
    return
  }
  roots.add(root)
  createdWorktreeRootsByRepo.set(repoId, roots)
  registeredWorktreeRootsRevisionByRepo.set(repoId, ++registeredWorktreeRootsRevisionSequence)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = true
}

/** The recovered layer outlives cache invalidation by design, so suites need an explicit reset. */
export function __resetCreatedWorktreeRootsForTests(): void {
  createdWorktreeRootsByRepo.clear()
  refreshRegisteredWorktreeRoots()
}

export function getRegisteredWorktreeRootsRevision(repoId: string): number {
  return registeredWorktreeRootsRevisionByRepo.get(repoId) ?? registeredWorktreeRootsBaseRevision
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
  for (const byRepo of [registeredWorktreeRootsByRepo, createdWorktreeRootsByRepo]) {
    for (const roots of byRepo.values()) {
      for (const root of roots) {
        registeredWorktreeRoots.add(root)
      }
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
