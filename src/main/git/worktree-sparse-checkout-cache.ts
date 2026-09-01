import { canonicalWorktreePath } from './worktree-path-comparison'
import { detectSparseCheckout } from './worktree-sparse-state'

// Why: `git worktree list` only emits a `sparse` porcelain line on newer Git (annotateSparseCheckoutStatus
// already skips rows where that's set), but Orca's compatibility baseline is Git 2.25, which predates it —
// so every listing still paid a per-worktree fs.stat + config read on the fallback path, measured at ~9x
// the cost of the `git worktree list` call it decorates on a 1000-worktree repo. Cache the result, scoped
// per repo so churn in one repo can't evict another's warm entries.
//
// Invalidation coverage:
//  - Orca-driven remove/move: explicit calls below (worktree-removal.ts, worktree-move.ts).
//  - External `git sparse-checkout` toggle while extensions.worktreeConfig is on: it rewrites
//    `config.worktree`, which the git-common-dir watcher already classifies as structural and
//    routes through notifyWorktreesChanged -> the invalidator this module registers (repo-scoped).
//  - External toggle with extensions.worktreeConfig off, or a bare pattern-file edit: unwitnessed
//    by the watcher (same blind spot `readRepoWorktreeAdminFingerprint` already documents and
//    accepts). Past the reconcile window below, a read still returns instantly from the stale entry
//    but also kicks a deduplicated background re-detect; a flip fires the change listener (wired to
//    the existing worktrees-changed notification) so the visible staleness window collapses from the
//    interval to one refresh cycle instead of blocking the listing that noticed it. That notification
//    itself runs the invalidator registered below, so a flip is immediately followed by a full clear
//    of the repo's cache (not just the one entry) -- an intentionally forced one-time full re-detect
//    on the rare edge that actually flipped, rather than partial state that could quietly diverge.
//  - App cold start: the map starts empty, so the first read is always a fresh detect.
const SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS = 5 * 60_000

type SparseCheckoutCacheEntry = {
  isSparse: boolean
  cachedAt: number
  revalidating?: Promise<void>
}

export type SparseCheckoutChangeListener = (
  repoPath: string,
  worktreePath: string,
  isSparse: boolean
) => void

const sparseCheckoutStateCache = new Map<string, SparseCheckoutCacheEntry>()
let changeListener: SparseCheckoutChangeListener | undefined

function cacheKey(repoPath: string, worktreePath: string): string {
  return `${canonicalWorktreePath(repoPath)}\0${canonicalWorktreePath(worktreePath)}`
}

/** Wired by the ipc/ layer to the shared worktrees-changed notification; last registration wins. */
export function onSparseCheckoutStateChanged(
  listener: SparseCheckoutChangeListener | undefined
): void {
  changeListener = listener
}

/** Cached wrapper around {@link detectSparseCheckout}; see module doc for invalidation coverage. */
export async function detectSparseCheckoutCached(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  const key = cacheKey(repoPath, worktreePath)
  const cached = sparseCheckoutStateCache.get(key)
  if (!cached) {
    const isSparse = await detectSparseCheckout(worktreePath)
    sparseCheckoutStateCache.set(key, { isSparse, cachedAt: Date.now() })
    return isSparse
  }
  if (Date.now() - cached.cachedAt < SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS) {
    return cached.isSparse
  }
  // Stale-while-revalidate: serve the still-cached value now and correct it in the background,
  // deduplicated so concurrent readers past the window don't each start their own probe.
  cached.revalidating ??= revalidateInBackground(key, repoPath, worktreePath, cached)
  return cached.isSparse
}

async function revalidateInBackground(
  key: string,
  repoPath: string,
  worktreePath: string,
  startingEntry: SparseCheckoutCacheEntry
): Promise<void> {
  try {
    const isSparse = await detectSparseCheckout(worktreePath)
    // Identity guard against a race with an explicit invalidate/clear -- or a remove+recreate at
    // the same path that repopulates the key with a fresh cold read -- while this was in flight.
    // A `has()`/presence check can't tell "still mine" from "someone else's fresh value" sharing
    // the key; comparing the map's current entry object to the one we started from can.
    if (sparseCheckoutStateCache.get(key) === startingEntry) {
      sparseCheckoutStateCache.set(key, { isSparse, cachedAt: Date.now() })
    }
    if (isSparse !== startingEntry.isSparse) {
      changeListener?.(repoPath, worktreePath, isSparse)
    }
  } catch {
    // Leave whatever's there in place; the next read past the window retries.
    if (sparseCheckoutStateCache.get(key) === startingEntry) {
      startingEntry.revalidating = undefined
    }
  }
}

/** Drop one worktree's cached state; call when Orca itself removes or moves a worktree path. */
export function invalidateSparseCheckoutState(repoPath: string, worktreePath: string): void {
  sparseCheckoutStateCache.delete(cacheKey(repoPath, worktreePath))
}

/** Clear one repo's cached entries; wired to the shared worktree-change invalidator registry in ipc/. */
export function clearSparseCheckoutStateCacheForRepo(repoPath: string): void {
  const prefix = `${canonicalWorktreePath(repoPath)}\0`
  for (const key of sparseCheckoutStateCache.keys()) {
    if (key.startsWith(prefix)) {
      sparseCheckoutStateCache.delete(key)
    }
  }
}

/** Clear every cached entry; fallback for a change notification whose repo can't be resolved to a path. */
export function clearSparseCheckoutStateCache(): void {
  sparseCheckoutStateCache.clear()
}

export function __resetSparseCheckoutStateCacheForTests(): void {
  sparseCheckoutStateCache.clear()
  changeListener = undefined
}

export function __getSparseCheckoutStateCacheSizeForTests(): number {
  return sparseCheckoutStateCache.size
}
