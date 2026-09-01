import { detectSparseCheckout } from './worktree-sparse-state'

// Why: `git worktree list` never reports sparse-checkout state (no such porcelain field exists), so
// every listing paid a per-worktree fs.stat + config read — measured at ~9x the cost of the `git
// worktree list` call it decorates on a 1000-worktree repo. Cache the result per worktree path.
//
// Invalidation coverage:
//  - Orca-driven remove/move: explicit calls below (worktree-removal.ts, worktree-move.ts).
//  - External `git sparse-checkout` toggle while extensions.worktreeConfig is on: it rewrites
//    `config.worktree`, which the git-common-dir watcher already classifies as structural and
//    routes through notifyWorktreesChanged -> the invalidator this module registers.
//  - External toggle with extensions.worktreeConfig off, or a bare pattern-file edit: unwitnessed
//    by the watcher (same blind spot `readRepoWorktreeAdminFingerprint` already documents and
//    accepts), bounded by the reconcile window below instead.
//  - App cold start: the map starts empty, so the first read is always a fresh detect.
const SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS = 5 * 60_000

type SparseCheckoutCacheEntry = {
  isSparse: boolean
  cachedAt: number
}

const sparseCheckoutStateCache = new Map<string, SparseCheckoutCacheEntry>()

/** Cached wrapper around {@link detectSparseCheckout}; see module doc for invalidation coverage. */
export async function detectSparseCheckoutCached(worktreePath: string): Promise<boolean> {
  const cached = sparseCheckoutStateCache.get(worktreePath)
  if (cached && Date.now() - cached.cachedAt < SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS) {
    return cached.isSparse
  }
  const isSparse = await detectSparseCheckout(worktreePath)
  sparseCheckoutStateCache.set(worktreePath, { isSparse, cachedAt: Date.now() })
  return isSparse
}

/** Drop one worktree's cached state; call when Orca itself removes or moves a worktree path. */
export function invalidateSparseCheckoutState(worktreePath: string): void {
  sparseCheckoutStateCache.delete(worktreePath)
}

/** Clear every cached entry; wired to the shared worktree-change invalidator registry in ipc/. */
export function clearSparseCheckoutStateCache(): void {
  sparseCheckoutStateCache.clear()
}

export function __resetSparseCheckoutStateCacheForTests(): void {
  sparseCheckoutStateCache.clear()
}

export function __getSparseCheckoutStateCacheSizeForTests(): number {
  return sparseCheckoutStateCache.size
}
