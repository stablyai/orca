import { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import type { RelayWatcherTeardownState } from './relay-watcher-teardown-tracker'

export function createRelayWatcherState(
  rootKey: string,
  rootPath: string,
  clientId: number,
  isStale: () => boolean,
  watchId?: number
): RelayWatcherTeardownState {
  return {
    clientWatchIds: watchId === undefined ? new Map() : new Map([[clientId, watchId]]),
    rootKey,
    rootPath,
    clients: new Map([[clientId, isStale]]),
    setupWaiters: new PromiseSettlementWaiters(Promise.resolve()),
    subscription: null,
    abortController: new AbortController(),
    generation: 0,
    closed: false
  }
}
