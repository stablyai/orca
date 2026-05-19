// In-process LRU keyed by accountId. Map-iteration order is insertion-order,
// so re-inserting on access promotes the entry to most-recently-used.
//
// Why null-sentinel: callers cache miss results too so a probe for a missing
// account doesn't re-shell-out on every PTY spawn (N+1 hot path in workspace
// launch).
export type KeychainCache = {
  get(key: string): string | null | undefined
  has(key: string): boolean
  set(key: string, value: string | null): void
  invalidate(key: string): void
  clear(): void
}

export function createKeychainCache(maxSize: number): KeychainCache {
  const map = new Map<string, string | null>()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const v = map.get(key) ?? null
      // Touch: re-insert to mark most-recently-used.
      map.delete(key)
      map.set(key, v)
      return v
    },
    has(key) {
      return map.has(key)
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      if (map.size > maxSize) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
    },
    invalidate(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    }
  }
}
