import type { GitWorktreeInfo } from '../../shared/worktree/types'

export type LineagePatternScanCache = {
  getOrLoad(
    repoPath: string,
    load: () => Promise<GitWorktreeInfo[]>,
    force?: boolean
  ): Promise<GitWorktreeInfo[]>
  clear(): void
}

type CacheEntry = { at: number; value: Promise<GitWorktreeInfo[]> }

export type LineagePatternScanCacheOptions = {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

/** Short-lived per-repo worktree-list cache; a Checks/Source Control mount must not re-run git per repo. */
export function createLineagePatternScanCache(
  options: LineagePatternScanCacheOptions = {}
): LineagePatternScanCache {
  const ttlMs = options.ttlMs ?? 5000
  const maxEntries = options.maxEntries ?? 100
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()

  return {
    getOrLoad(repoPath, load, force = false) {
      const existing = entries.get(repoPath)
      if (!force && existing && now() - existing.at < ttlMs) {
        return existing.value
      }
      const value = load()
      entries.delete(repoPath)
      entries.set(repoPath, { at: now(), value })
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) {
          entries.delete(oldest)
        }
      }
      // why: a failed scan must not be served for the whole TTL
      value.catch(() => {
        if (entries.get(repoPath)?.value === value) {
          entries.delete(repoPath)
        }
      })
      return value
    },
    clear() {
      entries.clear()
    }
  }
}

/** invariant: within one resolution a repo is scanned at most once, even when the caller forces a refresh. */
export function scopeLineageScanToRequest(cache: LineagePatternScanCache): LineagePatternScanCache {
  const loaded = new Set<string>()
  return {
    getOrLoad(repoPath, load, force = false) {
      const forceThisOne = force && !loaded.has(repoPath)
      loaded.add(repoPath)
      return cache.getOrLoad(repoPath, load, forceThisOne)
    },
    clear() {
      cache.clear()
    }
  }
}
