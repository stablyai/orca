import type { GitRuntimeOptions } from '../../command-runner/git-runtime-options'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { canonicalWorktreePath } from '../catalog/worktree-path-comparison'
import { detectSparseCheckout } from './worktree-sparse-state'

// Cache filesystem sparse probes; mutations and config.worktree changes invalidate entries.
// Unwatched pattern/shared-config edits reconcile in the background after five minutes; flips notify and clear the repo.
const SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS = 5 * 60_000
const MAX_UNLISTED_SPARSE_CHECKOUT_CACHE_ENTRIES = 512
const MAX_SPARSE_CHECKOUT_CACHE_SCOPES = 64

type SparseCheckoutProbeOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'signal'>

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

type SparseCheckoutCache = {
  repoPath: string
  workingSet: Set<string>
  entries: Map<string, SparseCheckoutCacheEntry>
  pending: Map<string, Promise<boolean>>
}

const sparseCheckoutStateCache = new Map<string, SparseCheckoutCache>()
let changeListener: SparseCheckoutChangeListener | undefined

function resolveCache(repoPath: string, options: SparseCheckoutProbeOptions): SparseCheckoutCache {
  const key = `${canonicalWorktreePath(repoPath)}\0${options.wslDistro?.trim().toLowerCase() ?? ''}`
  let cache = sparseCheckoutStateCache.get(key)
  if (!cache) {
    cache = {
      repoPath: canonicalWorktreePath(repoPath),
      workingSet: new Set(),
      entries: new Map(),
      pending: new Map()
    }
  }
  sparseCheckoutStateCache.delete(key)
  sparseCheckoutStateCache.set(key, cache)
  while (sparseCheckoutStateCache.size > MAX_SPARSE_CHECKOUT_CACHE_SCOPES) {
    const oldest = sparseCheckoutStateCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    retireCache(oldest)
  }
  return cache
}

function retireCache(key: string): void {
  const cache = sparseCheckoutStateCache.get(key)
  cache?.entries.clear()
  cache?.pending.clear()
  sparseCheckoutStateCache.delete(key)
}

function retainSparseCheckoutCacheEntry(
  cache: SparseCheckoutCache,
  key: string,
  entry: SparseCheckoutCacheEntry
): void {
  cache.entries.delete(key)
  cache.entries.set(key, entry)
  let excess =
    cache.entries.size - cache.workingSet.size - MAX_UNLISTED_SPARSE_CHECKOUT_CACHE_ENTRIES
  if (excess <= 0) {
    return
  }
  for (const candidate of cache.entries.keys()) {
    if (!cache.workingSet.has(candidate)) {
      cache.entries.delete(candidate)
      if (--excess <= 0) {
        break
      }
    }
  }
}

export function retainSparseCheckoutWorkingSet(
  repoPath: string,
  worktreePaths: Iterable<string>,
  options: SparseCheckoutProbeOptions = {}
): void {
  throwIfSignalAborted(options.signal)
  const cache = resolveCache(repoPath, options)
  cache.workingSet = new Set(Array.from(worktreePaths, (path) => canonicalWorktreePath(path)))
  for (const key of cache.entries.keys()) {
    if (!cache.workingSet.has(key)) {
      cache.entries.delete(key)
    }
  }
  for (const key of cache.pending.keys()) {
    if (!cache.workingSet.has(key)) {
      cache.pending.delete(key)
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
  throwIfSignalAborted(options.signal)
  const cache = resolveCache(repoPath, options)
  const key = canonicalWorktreePath(worktreePath)
  const cached = cache.entries.get(key)
  if (!cached) {
    let pending = cache.pending.get(key)
    if (!pending) {
      pending = detectSparseCheckout(worktreePath, options)
        .then((isSparse) => {
          if (cache.pending.get(key) === pending && !options.signal?.aborted) {
            retainSparseCheckoutCacheEntry(cache, key, { isSparse, cachedAt: Date.now() })
          }
          return isSparse
        })
        .finally(() => {
          if (cache.pending.get(key) === pending) {
            cache.pending.delete(key)
          }
        })
      cache.pending.set(key, pending)
    }
    return waitForPromiseWithSignal(pending, options.signal)
  }
  if (Date.now() - cached.cachedAt < SPARSE_CHECKOUT_CACHE_RECONCILE_INTERVAL_MS) {
    retainSparseCheckoutCacheEntry(cache, key, cached)
    return cached.isSparse
  }
  // Serve stale results while one background probe revalidates using this key's own options.
  cached.revalidating ??= revalidateInBackground(
    cache,
    key,
    repoPath,
    worktreePath,
    cached,
    options
  )
  return cached.isSparse
}

async function revalidateInBackground(
  cache: SparseCheckoutCache,
  key: string,
  repoPath: string,
  worktreePath: string,
  startingEntry: SparseCheckoutCacheEntry,
  options: SparseCheckoutProbeOptions
): Promise<void> {
  try {
    const isSparse = await detectSparseCheckout(worktreePath, options)
    // An invalidate or remove/recreate can replace the entry while this probe is in flight.
    if (cache.entries.get(key) === startingEntry && !options.signal?.aborted) {
      retainSparseCheckoutCacheEntry(cache, key, { isSparse, cachedAt: Date.now() })
      if (isSparse !== startingEntry.isSparse) {
        changeListener?.(repoPath, worktreePath, isSparse)
      }
    } else if (cache.entries.get(key) === startingEntry) {
      startingEntry.revalidating = undefined
    }
  } catch {
    // Leave whatever's there in place; the next read past the window retries.
    if (cache.entries.get(key) === startingEntry) {
      startingEntry.revalidating = undefined
    }
  }
}

/** Invalidate on Orca-driven removal or moves. */
export function invalidateSparseCheckoutState(repoPath: string, worktreePath: string): void {
  const repo = canonicalWorktreePath(repoPath)
  const worktree = canonicalWorktreePath(worktreePath)
  for (const cache of sparseCheckoutStateCache.values()) {
    if (cache.repoPath === repo) {
      cache.entries.delete(worktree)
      cache.pending.delete(worktree)
    }
  }
}

/** Clear one repo's cached entries; wired to the shared worktree-change invalidator registry in ipc/. */
export function clearSparseCheckoutStateCacheForRepo(repoPath: string): void {
  const repo = canonicalWorktreePath(repoPath)
  for (const [key, cache] of sparseCheckoutStateCache) {
    if (cache.repoPath === repo) {
      retireCache(key)
    }
  }
}

/** Clear all entries when a change notification cannot be resolved to a repo path. */
export function clearSparseCheckoutStateCache(): void {
  for (const key of sparseCheckoutStateCache.keys()) {
    retireCache(key)
  }
}

export function __resetSparseCheckoutStateCacheForTests(): void {
  clearSparseCheckoutStateCache()
  changeListener = undefined
}

export function __getSparseCheckoutStateCacheSizeForTests(): number {
  let size = 0
  for (const cache of sparseCheckoutStateCache.values()) {
    size += cache.entries.size
  }
  return size
}
