import type { SessionSearchStateCounts } from '../storage/session-search-store-types'
import type { SessionSearchDegradedRoot } from '../discovery/session-search-degraded-roots'

export type SessionSearchIndexPhase = 'idle' | 'indexing' | 'current' | 'degraded' | 'closed'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Rows indexed through the file stat they record. */
  filesIndexed: number
  /** Due rows plus unread candidates deferred by the last pass, which may have no row yet. */
  filesDue: number
  /** Rows whose last read did not commit. */
  filesFailed: number
  messagesIndexed: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
  /** Last full sweep with no deferred reads; null until one completes. */
  lastSweepCompletedAt: number | null
  sessionsByAgent: Record<string, number>
}

export function sessionSearchIndexStatus(
  counts: SessionSearchStateCounts | null,
  state: {
    closed: boolean
    started: boolean
    left: number
    pending: () => boolean
    degradedRoots: SessionSearchDegradedRoot[]
    lastReconcileAt: number | null
    lastSweepCompletedAt: number | null
  }
): SessionSearchIndexStatus {
  const settled = counts ?? {
    current: 0,
    due: 0,
    failed: 0,
    sessionsByAgent: {},
    messages: 0
  }
  const phase = (): SessionSearchIndexPhase => {
    if (state.closed) {
      return 'closed'
    }
    if (!state.started) {
      return 'idle'
    }
    if (state.degradedRoots.length > 0 || settled.failed > 0) {
      return 'degraded'
    }
    // Deferred candidates may have no rows, so due-row counts alone cannot prove completion.
    if (state.pending()) {
      return 'indexing'
    }
    return settled.due === 0 && state.lastSweepCompletedAt !== null ? 'current' : 'indexing'
  }
  return {
    phase: phase(),
    filesIndexed: settled.current,
    filesDue: settled.due + state.left,
    filesFailed: settled.failed,
    messagesIndexed: settled.messages,
    degradedRoots: state.degradedRoots.map((root) => ({ ...root })),
    lastReconcileAt: state.lastReconcileAt,
    lastSweepCompletedAt: state.lastSweepCompletedAt,
    sessionsByAgent: { ...settled.sessionsByAgent }
  }
}
