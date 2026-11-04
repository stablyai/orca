// Paired routes and direct SSH share storage; eviction and sweeps must check every owner's retention.
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
