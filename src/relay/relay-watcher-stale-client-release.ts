import type { RelayWatcherTeardownState } from './relay-watcher-teardown-tracker'

export function releaseStaleRelayWatches(
  states: Iterable<RelayWatcherTeardownState>,
  closeWatch: (state: RelayWatcherTeardownState) => Promise<void>
): Promise<void> | undefined {
  const teardowns: Promise<void>[] = []
  for (const state of Array.from(states)) {
    for (const [clientId, isStale] of state.clients) {
      if (isStale()) {
        state.clients.delete(clientId)
        state.clientWatchIds.delete(clientId)
      }
    }
    if (state.clients.size === 0) {
      teardowns.push(closeWatch(state))
    }
  }
  return teardowns.length > 0 ? Promise.all(teardowns).then(() => undefined) : undefined
}
