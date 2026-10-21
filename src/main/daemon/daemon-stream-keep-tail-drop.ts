/**
 * Keep-tail thinning for backgrounded sessions' queued stream data. Hidden
 * panes' stream copy is a monitoring feed (tail previews, agent status) — the
 * daemon emulator holds the complete model and reveal restores from its
 * snapshot. Once a backgrounded session's undelivered output exceeds the cap,
 * its OLDEST bytes are dropped down to the keep-tail and a dataGap event
 * takes their place, so the feed stays tail-fresh, daemon memory stays
 * bounded, and the producer is never paused (no reveal catch-up).
 */
import { clampToSafeSplitIndex } from './daemon-stream-data-split'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonEvent, DataGapEvent } from './types'
import type {
  AdmittedTransientRecord,
  DaemonTransientAdmission,
  TransientEntryLease
} from './daemon-transient-admission'
import {
  accountDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'

// A control entry carries a whole pre-shaped stream event (background marker,
// data gap, transient fact) that must ride at its exact position in the
// session's byte order; its data is always '' so it never counts against the
// gate or drop caps, and drops never remove it.
export type StreamQueueEntry = {
  sessionId: string
  data: string
  /** Original PTY characters represented by data. Salvaged query copies are
   * delivered bytes but represent zero new positions in the source stream. */
  sequenceChars?: number
  seq?: number
  transformed?: boolean
  queryOnly?: boolean
  control?: DaemonEvent
  observation?: AdmittedTransientRecord
  lease?: TransientEntryLease
  retainedBytes?: number
}

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: StreamQueueEntry[]
  admission?: DaemonTransientAdmission
  queuedChars: number
  // Per-session held totals so the flush hold can spare small talkers
  // (echo/replies) from waiting behind other sessions' floods.
  queuedCharsBySession: Map<string, number>
  queuedMetadataBytesBySession: Map<string, number>
  // Membership is reconciled when queued data first appears and on rare
  // background lifecycle changes, keeping steady-state enqueue constant-time.
  droppableQueuedSessionIds: Set<string>
  // Last droppable-sessions-with-queued-data count seen by the keep-tail
  // logic: when it GROWS the shared budget tightens, and sessions that
  // finished producing must be re-trimmed (they will never re-enqueue).
  lastEvaluatedDroppableSessionCount?: number
}

// The keep-tail must comfortably cover a full TUI repaint (~cols×rows×SGR ≈
// 100KB) so the delivered tail always re-renders a coherent screen.
// Hysteresis (cap = 2× keep) bounds drop churn.
// Kill switch: ORCA_DAEMON_BACKGROUND_STREAM_DROP=0 disables thinning.
const BACKGROUND_SESSION_KEEP_TAIL_CHARS = 512 * 1024
const BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS = 64 * 1024
// Why a GLOBAL budget too: the per-session cap bounds each flood, but N
// backgrounded sessions can still queue N×cap in aggregate — and a reveal
// (worktree switch) then waits behind the whole aggregate at the gated drain
// rate (~8MB/s event-loop-turn-bound; measured 9MB queued → 2.5s hidden
// restore vs the 1.5s budget). Shrinking each session's keep-tail as more
// backgrounded sessions queue keeps the total ~2MB, so any reveal drains in
// ~250ms while every pane still keeps at least a full screen of tail.
const BACKGROUND_GLOBAL_KEEP_BUDGET_CHARS = 2 * 1024 * 1024

export function backgroundSessionKeepTailChars(droppableSessionsWithQueuedData: number): number {
  return Math.min(
    BACKGROUND_SESSION_KEEP_TAIL_CHARS,
    Math.max(
      BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS,
      Math.floor(BACKGROUND_GLOBAL_KEEP_BUDGET_CHARS / Math.max(1, droppableSessionsWithQueuedData))
    )
  )
}

export function backgroundSessionDropCapChars(droppableSessionsWithQueuedData: number): number {
  return backgroundSessionKeepTailChars(droppableSessionsWithQueuedData) * 2
}
// Mirrors main's DROPPED_QUERY_SALVAGE_MAX_CHARS: salvage past this means a
// pathological query stream; keep the O(1) memory guarantee. A prior drop's
// salvage entry is itself the oldest data and re-salvages through the next
// drop, so query order is preserved across repeated drops.
const DROPPED_QUERY_SALVAGE_MAX_CHARS = 4096

/** Trim the session's OLDEST queued data down to the keep-tail and leave (or
 *  grow) a dataGap control entry where the dropped bytes were. Control
 *  entries are never dropped. Boundary note: the kept tail can start
 *  mid-escape-sequence — deliberate; the receiver treats a gap as a
 *  tail-preview reset and transient-fact scanning is daemon-authoritative
 *  for droppable sessions, so nothing downstream parses across the cut. */
export function dropOldestQueuedForSession(
  batch: PendingStreamDataBatch,
  sessionId: string,
  keepTailChars: number,
  salvageDroppedData: (
    dropped: string,
    maxChars: number,
    end?: number,
    accept?: (chars: number) => boolean
  ) => string
): void {
  let toDrop = (batch.queuedCharsBySession.get(sessionId) ?? 0) - keepTailChars
  if (toDrop <= 0) {
    return
  }
  let dropped = 0
  let salvagedChars = 0
  let retainedSalvage = 0
  retainedSalvage = batch.admission?.retainedQueryChars() ?? 0
  for (const entry of batch.queue) {
    if (entry.queryOnly && !entry.lease) {
      retainedSalvage += entry.data.length
    }
  }
  let gap: DataGapEvent | null = null
  let salvage: StreamQueueEntry | null = null
  let salvageLease: TransientEntryLease | undefined
  for (let i = 0; i < batch.queue.length && toDrop > 0; i++) {
    const entry = batch.queue[i]
    if (entry.sessionId !== sessionId) {
      continue
    }
    if (entry.observation) {
      if (entry.observation.installBoundary) {
        gap = null
        salvage = null
        salvageLease?.release()
        salvageLease = undefined
      }
      continue
    }
    if (entry.control?.event === 'dataGap') {
      gap = entry.control
      salvage = null
      salvageLease?.release()
      salvageLease = undefined
      continue
    }
    if (entry.control) {
      continue
    }
    // Previously salvaged queries remain ordered and consume the same aggregate allowance.
    if (entry.queryOnly) {
      salvage = entry
      continue
    }
    if (entry.data.length === 0) {
      continue
    }
    let gapLease: TransientEntryLease | undefined
    if (!gap) {
      const observing = batch.admission?.isObserving(sessionId)
      const reservation = batch.admission?.partition(sessionId, 4096 + 9216, 2, true)
      if (observing && !reservation) {
        gap = null
        salvage = null
        salvageLease?.release()
        salvageLease = undefined
        i = -1
        continue
      }
      if (reservation) {
        gapLease = reservation.owner.split(reservation, 4096)
        salvageLease = reservation
      }
    }
    const cut = clampToSafeSplitIndex(entry.data, 0, Math.min(toDrop, entry.data.length))
    if (cut <= 0) {
      gapLease?.release()
      break
    }
    const sequenceChars = entry.sequenceChars ?? entry.data.length
    const rawCut = cut === entry.data.length ? sequenceChars : sequenceChars === 0 ? 0 : cut
    if (!gap) {
      gap = {
        type: 'event',
        event: 'dataGap',
        sessionId,
        payload: {
          droppedChars: 0,
          sequenceChars: 0
        }
      }
      batch.queue.splice(
        i++,
        0,
        accountDaemonStreamEntry(batch, { sessionId, data: '', control: gap, lease: gapLease })
      )
      salvage = null
    }
    gap.payload.droppedChars += cut
    gap.payload.sequenceChars = (gap.payload.sequenceChars ?? 0) + rawCut
    if (retainedSalvage + salvagedChars < DROPPED_QUERY_SALVAGE_MAX_CHARS) {
      if (!salvage && !salvageLease) {
        salvageLease = batch.admission?.partition(sessionId, 9216, 1, true)
      }
      const queries = salvageDroppedData(
        entry.data,
        DROPPED_QUERY_SALVAGE_MAX_CHARS - retainedSalvage - salvagedChars,
        cut,
        (chars) => {
          const lease = salvage?.lease ?? salvageLease
          if (batch.admission?.isObserving(sessionId) && !lease) {
            return false
          }
          if (lease) {
            lease.queryChars += chars
          }
          return true
        }
      )
      if (queries) {
        if (!salvage) {
          salvage = accountDaemonStreamEntry(batch, {
            sessionId,
            data: '',
            sequenceChars: 0,
            queryOnly: true,
            lease: salvageLease
          })
          salvageLease = undefined
          batch.queue.splice(i++, 0, salvage)
        }
        salvage.data += queries
        salvagedChars += queries.length
      }
    }
    dropped += cut
    toDrop -= cut
    if (cut === entry.data.length) {
      releaseDaemonStreamEntry(batch, entry)
      entry.lease?.release()
      batch.queue.splice(i--, 1)
    } else {
      entry.data = entry.data.slice(cut)
      const remaining = sequenceChars - rawCut
      entry.sequenceChars = remaining === entry.data.length ? undefined : remaining
      break
    }
  }
  salvageLease?.release()
  if (dropped === 0) {
    return
  }
  batch.queuedChars += salvagedChars - dropped
  batch.queuedCharsBySession.set(
    sessionId,
    Math.max(0, (batch.queuedCharsBySession.get(sessionId) ?? 0) + salvagedChars - dropped)
  )
  recordDaemonStreamBacklogEvent('backgroundKeepTailDrop', {
    sessionIdSuffix: sessionId.slice(-10),
    droppedChars: dropped
  })
}
