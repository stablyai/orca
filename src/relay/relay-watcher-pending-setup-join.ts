import type { RelayWatcherPendingSetup } from './relay-watcher-setup-tracking'
import { awaitRelayWatcherSetup } from './relay-watcher-setup-wait'

export async function joinRelayWatcherPendingSetup(
  pendingSetup: RelayWatcherPendingSetup,
  signal: AbortSignal | undefined,
  retry: () => Promise<void>
): Promise<void> {
  try {
    await awaitRelayWatcherSetup(pendingSetup, signal)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return
    }
    // Why: the previous caller's failure must not poison a later same-root
    // attempt once its single serialized setup generation has released.
  }
  if (!signal?.aborted) {
    await retry()
  }
}
