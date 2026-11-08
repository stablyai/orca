import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

const ROWS_KEY = 'rows'
// A busy agent changes its row on every step; phones re-read the whole worktree.ps per notice.
const ROWS_FLUSH_MS = 500
const ROWS_MAX_WAIT_MS = 2000

/** Tells phones an agent row changed, so their workspace lists re-read worktree.ps instead of polling. */
export function publishWorktreeRowsChanges(
  store: Pick<AgentStatusStoreView, 'subscribeStatusRowMutations'>,
  emit: (event: RuntimeClientEvent) => void
): () => void {
  const coalescer = createKeyedTrailingEdgeCoalescer(() => emit({ type: 'worktreeRowsChanged' }), {
    flushMs: ROWS_FLUSH_MS,
    maxWaitMs: ROWS_MAX_WAIT_MS
  })
  const unsubscribe = store.subscribeStatusRowMutations(() => coalescer.schedule(ROWS_KEY))
  return () => {
    unsubscribe()
    coalescer.dispose()
  }
}
