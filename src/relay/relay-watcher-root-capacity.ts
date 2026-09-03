import { WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE } from '../shared/watch-root-capacity-refusal'

const MAX_RELAY_WATCH_ROOTS = 20

// Why teardown roots count: a root still unsubscribing owns its native handles until it settles.
export function exceedsRelayWatcherRootCapacity(
  activeRoots: Iterable<string>,
  pendingRoots: Iterable<string>,
  teardownRoots: Iterable<string>,
  prospectiveRoot: string
): boolean {
  const physicalRoots = new Set([...activeRoots, ...pendingRoots, ...teardownRoots])
  physicalRoots.add(prospectiveRoot)
  return physicalRoots.size > MAX_RELAY_WATCH_ROOTS
}

export function assertRelayWatcherRootCapacity(
  activeRoots: Iterable<string>,
  pendingRoots: Iterable<string>,
  teardownRoots: Iterable<string>,
  prospectiveRoot: string
): void {
  if (exceedsRelayWatcherRootCapacity(activeRoots, pendingRoots, teardownRoots, prospectiveRoot)) {
    throw new Error(WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE)
  }
}
