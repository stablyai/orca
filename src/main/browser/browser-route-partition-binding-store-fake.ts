import type { BrowserRoutePartitionBindingStore } from './browser-route-session-registry-contract'

export type BrowserRoutePartitionBindingStoreFake = BrowserRoutePartitionBindingStore & {
  entries: Map<string, { fingerprint: string; storageScope: string }>
}

/** In-memory stand-in for the persisted binding store, for tests that only need its semantics. */
export function createBrowserRoutePartitionBindingStoreFake(): BrowserRoutePartitionBindingStoreFake {
  const entries = new Map<string, { fingerprint: string; storageScope: string }>()
  return {
    entries,
    get: (partition) => entries.get(partition)?.fingerprint ?? null,
    set: (partition, fingerprint, storageScope) => {
      entries.set(partition, { fingerprint, storageScope })
      return []
    },
    touch: () => {},
    findPartitionByFingerprint: (fingerprint) => {
      for (const [partition, entry] of entries) {
        if (entry.fingerprint === fingerprint) {
          return partition
        }
      }
      return null
    },
    rebind: (partition, fingerprint, storageScope) => {
      entries.set(partition, { fingerprint, storageScope })
    }
  }
}
