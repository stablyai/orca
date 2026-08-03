const MAX_RELAY_WATCH_ROOTS = 20

export function assertRelayWatcherRootCapacity(
  activeRoots: Iterable<string>,
  pendingRoots: Iterable<string>,
  teardownRoots: Iterable<string>,
  prospectiveRoot: string
): void {
  const physicalRoots = new Set([...activeRoots, ...pendingRoots, ...teardownRoots])
  physicalRoots.add(prospectiveRoot)
  if (physicalRoots.size > MAX_RELAY_WATCH_ROOTS) {
    throw new Error('Maximum number of file watchers reached')
  }
}
