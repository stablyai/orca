import type { GitRuntimeOptions } from './git-runtime-options'
import { canonicalWorktreePath } from './worktree-path-comparison'
import { detectSparseCheckout } from './worktree-sparse-state'

// Cache filesystem sparse probes; mutations and config.worktree changes invalidate entries.
// Unwatched pattern/shared-config edits reconcile in the background after five minutes; flips notify and clear the repo.
const SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS = 5 * 60_000
export const MAX_SPARSE_CHECKOUT_CACHE_ENTRIES = 512

// Every probe option must join cacheKey: distro-less probes can resolve a different gitdir.
type SparseCheckoutProbeOptions = Pick<GitRuntimeOptions, 'wslDistro'>

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

function retainSparseCheckoutCacheEntry(key: string, entry: SparseCheckoutCacheEntry): void {
  sparseCheckoutStateCache.delete(key)
  sparseCheckoutStateCache.set(key, entry)
  while (sparseCheckoutStateCache.size > MAX_SPARSE_CHECKOUT_CACHE_ENTRIES) {
    const oldest = sparseCheckoutStateCache.keys().next()
    if (oldest.done || oldest.value === key) {
      break
    }
    sparseCheckoutStateCache.delete(oldest.value)
  }
}

// Distro last so the repo- and worktree-scoped prefix deletes below still match every variant.
function cacheKey(
  repoPath: string,
  worktreePath: string,
  options: SparseCheckoutProbeOptions
): string {
  return `${worktreeKeyPrefix(repoPath, worktreePath)}${options.wslDistro?.trim().toLowerCase() ?? ''}`
}

function worktreeKeyPrefix(repoPath: string, worktreePath: string): string {
  return `${canonicalWorktreePath(repoPath)}\0${canonicalWorktreePath(worktreePath)}\0`
}

function deleteKeysWithPrefix(prefix: string): void {
  for (const key of sparseCheckoutStateCache.keys()) {
    if (key.startsWith(prefix)) {
      sparseCheckoutStateCache.delete(key)
    }
  }
}

/** Wired by the ipc/ layer to the shared worktrees-changed notification; last registration wins. */
export function onSparseCheckoutStateChanged(
  listener: SparseCheckoutChangeListener | undefined
): void {
  changeListener = listener
}

export async function detectSparseCheckoutCached(
  repoPath: string,
  worktreePath: string,
  options: SparseCheckoutProbeOptions = {}
): Promise<boolean> {
  const key = cacheKey(repoPath, worktreePath, options)
  const cached = sparseCheckoutStateCache.get(key)
  if (!cached) {
    const isSparse = await detectSparseCheckout(worktreePath, options)
    retainSparseCheckoutCacheEntry(key, { isSparse, cachedAt: Date.now() })
    return isSparse
  }
  if (Date.now() - cached.cachedAt < SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS) {
    retainSparseCheckoutCacheEntry(key, cached)
    return cached.isSparse
  }
  // Serve stale results while one background probe revalidates using this key's own options.
  cached.revalidating ??= revalidateInBackground(key, repoPath, worktreePath, cached, options)
  return cached.isSparse
}

async function revalidateInBackground(
  key: string,
  repoPath: string,
  worktreePath: string,
  startingEntry: SparseCheckoutCacheEntry,
  options: SparseCheckoutProbeOptions
): Promise<void> {
  try {
    const isSparse = await detectSparseCheckout(worktreePath, options)
    // An invalidate or remove/recreate can replace the entry while this probe is in flight.
    if (sparseCheckoutStateCache.get(key) === startingEntry) {
      retainSparseCheckoutCacheEntry(key, { isSparse, cachedAt: Date.now() })
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

/** Invalidate on Orca-driven removal or moves. */
export function invalidateSparseCheckoutState(repoPath: string, worktreePath: string): void {
  deleteKeysWithPrefix(worktreeKeyPrefix(repoPath, worktreePath))
}

/** Clear one repo's cached entries; wired to the shared worktree-change invalidator registry in ipc/. */
export function clearSparseCheckoutStateCacheForRepo(repoPath: string): void {
  deleteKeysWithPrefix(`${canonicalWorktreePath(repoPath)}\0`)
}

/** Clear all entries when a change notification cannot be resolved to a repo path. */
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
