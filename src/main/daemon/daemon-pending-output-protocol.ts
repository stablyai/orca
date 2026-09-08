import type { TerminalSnapshot } from './terminal-snapshot'

// Why: the 5s checkpoint used to re-serialize the full emulator buffer per
// tick, stalling the daemon's PTY pump for O(buffer). Incremental checkpoints
// take only the raw records accumulated since the last take; the emulator is
// serialized only when a full snapshot is explicitly requested.
export type PendingOutputRecord =
  | { kind: 'output'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'clear' }

export type TakePendingOutputRequest = {
  id: string
  type: 'takePendingOutput'
  payload: {
    sessionId: string
    /** When true, the daemon serializes a full snapshot in the SAME
     *  synchronous turn as the take. This atomicity is load-bearing: a
     *  snapshot taken in a separate request could include bytes that a later
     *  take would replay again, duplicating content on cold restore. */
    includeSnapshot?: boolean
    /** True only for final checkpoints taken immediately before PTY teardown.
     *  This lets the daemon release pending parser-state bytes that should be
     *  preserved before the backing PTY is destroyed, without disturbing live
     *  full checkpoints or warm-reconnect checkpoints. */
    teardownSnapshot?: boolean
  }
}

export type TakePendingOutputResult = {
  records: PendingOutputRecord[]
  /** Drained pending queue. Absent on older daemons. includeSnapshot still
   *  keeps `records` as held-only so mixed-version adapters do not double-replay. */
  drainedRecords?: PendingOutputRecord[]
  /** Non-decreasing per-session batch sequence. The history log stores it so the
   *  cold-restore reader can detect a lost batch (gap) and discard the log
   *  instead of replaying a stream with missing bytes. Snapshot, record, and
   *  overflow takes advance it; empty incremental takes repeat the prior value. */
  seq: number
  /** True when the session's pending buffer exceeded its cap and records were
   *  dropped. The caller must fall back to a full snapshot checkpoint. */
  overflowed: boolean
  snapshot: TerminalSnapshot | null
}
