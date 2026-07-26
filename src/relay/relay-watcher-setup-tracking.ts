import { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'

export type RelayWatcherPendingSetup = PromiseSettlementWaiters<void>

export function trackRelayWatcherSetup(
  pendingSetups: Map<string, RelayWatcherPendingSetup>,
  rootKey: string,
  setup: Promise<void>
): Promise<void> {
  let tracked!: RelayWatcherPendingSetup
  const trackedPromise = setup.finally(() => {
    if (pendingSetups.get(rootKey) === tracked) {
      pendingSetups.delete(rootKey)
    }
  })
  tracked = new PromiseSettlementWaiters(trackedPromise)
  pendingSetups.set(rootKey, tracked)
  return tracked.promise
}
