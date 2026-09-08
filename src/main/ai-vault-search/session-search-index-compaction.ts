import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'

const COMPACT_PAGES_PER_STEP = 2000

/** Hands freed pages back to the filesystem in bounded steps, never one long stall. */
export async function compactSessionSearchIndex(
  db: SyncDatabase,
  stopped: () => boolean
): Promise<void> {
  let freed = Number(db.pragma('freelist_count', { simple: true }))
  while (!stopped() && freed > 0) {
    db.pragma(`incremental_vacuum(${COMPACT_PAGES_PER_STEP})`)
    const remaining = Number(db.pragma('freelist_count', { simple: true }))
    // Why: without auto_vacuum the step is a no-op; never spin on it.
    if (remaining >= freed) {
      return
    }
    freed = remaining
    await yieldToEventLoop()
  }
}
