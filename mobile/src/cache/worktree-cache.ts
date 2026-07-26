// Why: module-level cache lets the home screen pre-populate worktree data
// so the host detail page can render instantly on navigation instead of
// waiting for a fresh RPC connection + fetch cycle.

import { MobileRpcListCache } from './mobile-rpc-list-cache'

const MAX_AGE_MS = 30_000
export const MOBILE_WORKTREE_CACHE_MAX_ENTRIES = 20
export const MOBILE_WORKTREE_CACHE_MAX_ITEMS_PER_HOST = 10_000
export const MOBILE_WORKTREE_CACHE_MAX_RETAINED_BYTES = 16 * 1024 * 1024

const cache = new MobileRpcListCache(
  MAX_AGE_MS,
  MOBILE_WORKTREE_CACHE_MAX_ENTRIES,
  MOBILE_WORKTREE_CACHE_MAX_ITEMS_PER_HOST,
  MOBILE_WORKTREE_CACHE_MAX_RETAINED_BYTES
)

export function setCachedWorktrees(hostId: string, worktrees: unknown[]): void {
  cache.set(hostId, worktrees)
}

export function getCachedWorktrees(hostId: string): unknown[] | null {
  return cache.get(hostId)
}

/** Test-only: clear process-lifetime cache state between cases. */
export function resetWorktreeCacheForTests(): void {
  cache.clear()
}
