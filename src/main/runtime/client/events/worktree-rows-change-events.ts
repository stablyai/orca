import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from './keyed-trailing-edge-coalescer'

const ROWS_KEY = 'rows'
// A busy agent changes its row on every step; phones re-read the whole worktree.ps per notice.
const ROWS_FLUSH_MS = 500
const ROWS_MAX_WAIT_MS = 2000

/** Tells phones an agent's status changed, so their workspace lists re-read worktree.ps instead of polling. */
export class WorktreeRowsChanges {
  private readonly coalescer: KeyedTrailingEdgeCoalescer

  constructor(emit: (event: RuntimeClientEvent) => void) {
    this.coalescer = createKeyedTrailingEdgeCoalescer(() => emit({ type: 'worktreeRowsChanged' }), {
      flushMs: ROWS_FLUSH_MS,
      maxWaitMs: ROWS_MAX_WAIT_MS
    })
  }

  changed(): void {
    this.coalescer.schedule(ROWS_KEY)
  }
}
