// WORKER-XREQ-PROMISE: an isolate serves many requests, and a promise one request starts is bound to that
// request's I/O. If it is cancelled (its client went away) while the promise waits on D1, KMS or fetch, the
// promise never settles, and every later request awaiting the same promise hangs until the runtime cancels
// it too. Module-level caches must therefore hold settled VALUES only, never in-flight promises: a request
// that misses loads for itself (a few duplicate loads on a cold isolate are the price).

export type SettledCache<V> = {
  /** The cached value while fresh, else `load()` (this request's own), cached once it resolves. */
  get(key: string, now: number, load: () => Promise<V>): Promise<V>
  delete(key: string): void
  deleteWhere(match: (key: string) => boolean): void
}

export function settledCache<V>(ttlMs: number, maxEntries = 1000): SettledCache<V> {
  const entries = new Map<string, { at: number; value: V }>()
  return {
    async get(key, now, load) {
      const hit = entries.get(key)
      if (hit && now - hit.at < ttlMs) {
        return hit.value
      }
      const value = await load()
      if (entries.size >= maxEntries) {
        for (const [stale, entry] of entries) {
          if (now - entry.at >= ttlMs) {
            entries.delete(stale)
          }
        }
      }
      entries.set(key, { at: now, value })
      return value
    },
    delete: (key) => void entries.delete(key),
    deleteWhere(match) {
      for (const key of [...entries.keys()]) {
        if (match(key)) {
          entries.delete(key)
        }
      }
    }
  }
}
