/** Thin the monitoring stream while retaining the complete daemon model for snapshot recovery. */
import { clampToSafeSplitIndex } from './daemon-stream-data-split'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonEvent, DataGapEvent } from './types'
import type { TerminalObservationEvent } from './daemon-stream-events'
import {
  accountDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'

// Keep control events at their stream position; empty payloads do not exempt their metadata from backpressure.
export type StreamQueueEntry = {
  sessionId: string
  data: string
  /** Source PTY characters represented; salvaged query copies advance the stream by zero. */
  sequenceChars?: number
  seq?: number
  transformed?: boolean
  queryOnly?: boolean
  control?: DaemonEvent
  observation?: TerminalObservationEvent
  retainedBytes?: number
  queued?: boolean
  discarded?: boolean
}

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: StreamQueueEntry[]
  latestSnapshots?: Map<string, StreamQueueEntry>
  discardedEntries?: number
  queuedChars: number
  // Track each session so small replies can bypass other sessions' held floods.
  queuedCharsBySession: Map<string, number>
  queuedMetadataBytesBySession: Map<string, number>
  // Cache membership to keep steady-state enqueue constant-time.
  droppableQueuedSessionIds: Set<string>
  // Growth tightens the shared budget, requiring re-trimming even sessions that stopped producing.
  lastEvaluatedDroppableSessionCount?: number
}

// Keep enough tail for a full TUI repaint; the 2x drop cap limits trimming churn.
const BACKGROUND_SESSION_KEEP_TAIL_CHARS = 512 * 1024
const BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS = 64 * 1024
// Share the tail budget across sessions to limit aggregate backlog, subject to each session's minimum.
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
// Bound query salvage across repeated drops; re-salvage prior entries to retain query order.
const DROPPED_QUERY_SALVAGE_MAX_CHARS = 4096

/** Gaps reset downstream previews, so kept tails may begin inside escapes; control events survive trimming. */
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
  for (const entry of batch.queue) {
    if (entry.queryOnly) {
      retainedSalvage += entry.data.length
    }
  }
  let gap: DataGapEvent | null = null
  let salvage: StreamQueueEntry | null = null
  for (let i = 0; i < batch.queue.length && toDrop > 0; i++) {
    const entry = batch.queue[i]
    if (entry.sessionId !== sessionId) {
      continue
    }
    if (entry.observation) {
      continue
    }
    if (entry.control?.event === 'dataGap') {
      gap = entry.control
      salvage = null
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
    const cut = clampToSafeSplitIndex(entry.data, 0, Math.min(toDrop, entry.data.length))
    if (cut <= 0) {
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
        accountDaemonStreamEntry(batch, { sessionId, data: '', control: gap })
      )
      salvage = null
    }
    gap.payload.droppedChars += cut
    gap.payload.sequenceChars = (gap.payload.sequenceChars ?? 0) + rawCut
    if (retainedSalvage + salvagedChars < DROPPED_QUERY_SALVAGE_MAX_CHARS) {
      const queries = salvageDroppedData(
        entry.data,
        DROPPED_QUERY_SALVAGE_MAX_CHARS - retainedSalvage - salvagedChars,
        cut
      )
      if (queries) {
        if (!salvage) {
          salvage = accountDaemonStreamEntry(batch, {
            sessionId,
            data: '',
            sequenceChars: 0,
            queryOnly: true
          })
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
      batch.queue.splice(i--, 1)
    } else {
      entry.data = entry.data.slice(cut)
      const remaining = sequenceChars - rawCut
      entry.sequenceChars = remaining === entry.data.length ? undefined : remaining
      break
    }
  }
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
