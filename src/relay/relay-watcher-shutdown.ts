import type { RelayWatcherPendingSetup } from './relay-watcher-setup-tracking'
import type { RelayWatcherProcessPool } from './relay-watcher-process-pool'
import type {
  RelayWatcherTeardownState,
  RelayWatcherTeardownTracker
} from './relay-watcher-teardown-tracker'

export async function disposeRelayWatchesAndWait(
  closeWatches: () => Promise<void>,
  pool: RelayWatcherProcessPool
): Promise<void> {
  const close = closeWatches()
  const children = Promise.resolve().then(() => {
    if (!pool.disposeAndWait) {
      throw new Error('relay_watcher_pool_awaited_disposal_unavailable')
    }
    return pool.disposeAndWait()
  })
  const results = await Promise.allSettled([close, children])
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'relay_watcher_shutdown_incomplete'
    )
  }
}

export async function closeRelayWatchesAndWait(
  watches: ReadonlyMap<string, RelayWatcherTeardownState>,
  pendingSetups: ReadonlyMap<string, RelayWatcherPendingSetup>,
  tracker: RelayWatcherTeardownTracker,
  close: (state: RelayWatcherTeardownState) => Promise<void>
): Promise<void> {
  const states = new Set(watches.values())
  for (const root of tracker.rootPaths()) {
    const failed = tracker.failedState(root)
    if (failed) {
      states.add(failed)
    }
  }
  const closures = Promise.allSettled([...states].map(close))
  // Setup refusal is expected after fencing; retained teardown failures remain authoritative.
  await Promise.allSettled([...pendingSetups.values()].map((setup) => setup.promise))
  const results = await closures
  const remaining = await Promise.allSettled(tracker.rootPaths().map((root) => tracker.join(root)))
  const failures = [...results, ...remaining].filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    throw new AggregateError(
      [...new Set(failures.map((failure) => failure.reason))],
      'relay_watcher_shutdown_incomplete'
    )
  }
}
