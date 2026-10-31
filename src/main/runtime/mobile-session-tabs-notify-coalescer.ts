// Title spinners churn snapshots; coalesce to the newest version per workspace to avoid per-client serialization.
// Structural changes bypass coalescing and publish immediately.

import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from './keyed-trailing-edge-coalescer'

// Keep title/status latency below file watching while allowing more coalescing than native chat.
const SESSION_TABS_FLUSH_MS = 50
const SESSION_TABS_MAX_WAIT_MS = 250

export type MobileSessionTabsNotifyCoalescer = KeyedTrailingEdgeCoalescer

/** emit must read the latest snapshot; clients already discard superseded snapshotVersions. */
export function createMobileSessionTabsNotifyCoalescer(
  emit: (worktreeId: string) => void
): MobileSessionTabsNotifyCoalescer {
  return createKeyedTrailingEdgeCoalescer(emit, {
    flushMs: SESSION_TABS_FLUSH_MS,
    maxWaitMs: SESSION_TABS_MAX_WAIT_MS
  })
}
