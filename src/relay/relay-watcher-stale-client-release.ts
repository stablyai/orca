import type { RelayWatcherTeardownState } from './relay-watcher-teardown-tracker'

/** Drops stale clients from one watch, sparing `keep` (the caller's own client). */
export function pruneStaleRelayWatchClients(state: RelayWatcherTeardownState, keep?: number): void {
  for (const [clientId, isStale] of state.clients) {
    if (clientId !== keep && isStale()) {
      state.clients.delete(clientId)
      state.clientWatchIds.delete(clientId)
    }
  }
}

export function releaseStaleRelayWatches(
  states: Iterable<RelayWatcherTeardownState>,
  closeWatch: (state: RelayWatcherTeardownState) => Promise<void>
): Promise<void> | undefined {
  const teardowns: Promise<void>[] = []
  for (const state of Array.from(states)) {
    pruneStaleRelayWatchClients(state)
    if (state.clients.size === 0) {
      teardowns.push(closeWatch(state))
    }
  }
  return teardowns.length > 0 ? Promise.all(teardowns).then(() => undefined) : undefined
}
