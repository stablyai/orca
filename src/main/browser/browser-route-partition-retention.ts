/**
 * Retention probes for route partitions. Two independent owners exist — the
 * paired-route session registry and the local direct-SSH partition set — and
 * binding-store eviction or a storage sweep initiated by either must never
 * destroy a partition the other is serving. Each owner registers a probe; all
 * destruction paths ask the union.
 */
const probes = new Set<(partition: string) => boolean>()

export function registerBrowserRoutePartitionRetentionProbe(
  probe: (partition: string) => boolean
): () => void {
  probes.add(probe)
  return () => {
    probes.delete(probe)
  }
}

export function isBrowserRoutePartitionRetainedByAnyOwner(partition: string): boolean {
  for (const probe of probes) {
    if (probe(partition)) {
      return true
    }
  }
  return false
}
