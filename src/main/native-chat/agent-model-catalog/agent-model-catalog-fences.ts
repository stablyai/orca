/** One abort signal per key (an agent's scopes) until it retires. */
export function createAgentModelCatalogFences<K>() {
  const fences = new Map<K, AbortController>()
  return {
    signal(key: K): AbortSignal {
      const fence = fences.get(key) ?? new AbortController()
      fences.set(key, fence)
      return fence.signal
    },
    /** Retires one key, or every key without one. */
    retire(key?: K): void {
      for (const [held, fence] of fences) {
        if (key === undefined || held === key) {
          fence.abort()
          fences.delete(held)
        }
      }
    }
  }
}
