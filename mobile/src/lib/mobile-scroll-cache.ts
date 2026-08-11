// Why: Module-scoped Map survives component unmount/remount without triggering
// React re-renders. LRU eviction caps memory at ~15 entries — scroll positions
// are non-critical caches, so eviction just means the user sees top-of-tab.

const CACHE_MAX_ENTRIES = 15

export function setWithLRU<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = CACHE_MAX_ENTRIES
): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > maxEntries) {
    const first = map.keys().next()
    if (!first.done) {
      map.delete(first.value)
    }
  }
}

export const mobileScrollCache = new Map<string, number>()
