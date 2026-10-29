import type { BrowserRoutePartitionBindingStore } from './browser-route-session-registry-contract'

export type BrowserRoutePartitionBindingStoreFake = BrowserRoutePartitionBindingStore & {
  entries: Map<string, FakeBinding>
}

type FakeBinding = { fingerprint: string; storageScope: string; aliasFingerprints?: string[] }

export function createBrowserRoutePartitionBindingStoreFake(): BrowserRoutePartitionBindingStoreFake {
  const entries = new Map<string, FakeBinding>()
  return {
    entries,
    get: (partition) => entries.get(partition)?.fingerprint ?? null,
    set: (partition, fingerprint, storageScope, alias) => {
      entries.set(partition, {
        fingerprint,
        storageScope,
        ...(alias ? { aliasFingerprints: [alias] } : {})
      })
      return []
    },
    touch: () => {},
    findPartitionByFingerprint: (fingerprint) => {
      for (const [partition, entry] of entries) {
        if (entry.fingerprint === fingerprint || entry.aliasFingerprints?.includes(fingerprint)) {
          return partition
        }
      }
      return null
    },
    rebind: (partition, fingerprint, storageScope, alias) => {
      const existing = entries.get(partition)
      if (!existing) {
        throw new Error('browser_route_partition_binding_invalid')
      }
      const aliases = (existing.aliasFingerprints ?? []).filter((entry) => entry !== fingerprint)
      entries.set(partition, {
        fingerprint,
        storageScope,
        aliasFingerprints: alias && !aliases.includes(alias) ? [...aliases, alias] : aliases
      })
    }
  }
}
