/** Thin the monitoring stream while retaining the complete daemon model for snapshot recovery. */
import { clampToSafeSplitIndex } from './daemon-stream-data-split'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonEvent, DataGapEvent } from './types'
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
  control?: DaemonEvent
  retainedBytes?: number
}

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: StreamQueueEntry[]
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
  salvageDroppedData: (dropped: string) => string
): void {
  let toDrop = (batch.queuedCharsBySession.get(sessionId) ?? 0) - keepTailChars
  if (toDrop <= 0) {
    return
  }
  const totalDropped = toDrop
  let droppedSequenceChars = 0
  let salvaged = ''
  const salvageIntoCap = (dropped: string): void => {
    if (salvaged.length >= DROPPED_QUERY_SALVAGE_MAX_CHARS) {
      return
    }
    salvaged = (salvaged + salvageDroppedData(dropped)).slice(0, DROPPED_QUERY_SALVAGE_MAX_CHARS)
  }
  let existingGap: DataGapEvent | null = null
  let insertGapAt = -1
  for (let i = 0; i < batch.queue.length && toDrop > 0; i++) {
    const entry = batch.queue[i]
    if (entry.sessionId !== sessionId) {
      continue
    }
    if (entry.control) {
      if (entry.control.event === 'dataGap') {
        existingGap = entry.control
      }
      continue
    }
    if (entry.data.length <= toDrop) {
      toDrop -= entry.data.length
      droppedSequenceChars += entry.sequenceChars ?? entry.data.length
      salvageIntoCap(entry.data)
      if (insertGapAt === -1) {
        insertGapAt = i
      }
      releaseDaemonStreamEntry(batch, entry)
      batch.queue.splice(i, 1)
      i--
    } else {
      const cut = clampToSafeSplitIndex(entry.data, 0, toDrop)
      if (cut > 0) {
        const entrySequenceChars = entry.sequenceChars ?? entry.data.length
        const cutSequenceChars = entrySequenceChars === 0 ? 0 : cut
        droppedSequenceChars += cutSequenceChars
        salvageIntoCap(entry.data.slice(0, cut))
        entry.data = entry.data.slice(cut)
        const remainingSequenceChars = entrySequenceChars - cutSequenceChars
        entry.sequenceChars =
          remainingSequenceChars === entry.data.length ? undefined : remainingSequenceChars
        if (insertGapAt === -1) {
          insertGapAt = i
        }
      }
      toDrop = 0
    }
  }
  const dropped = totalDropped - toDrop
  if (dropped <= 0) {
    return
  }
  batch.queuedChars -= dropped
  batch.queuedCharsBySession.set(
    sessionId,
    Math.max(0, (batch.queuedCharsBySession.get(sessionId) ?? 0) - dropped)
  )
  if (existingGap) {
    const priorSequenceChars = existingGap.payload.sequenceChars ?? existingGap.payload.droppedChars
    existingGap.payload.droppedChars += dropped
    existingGap.payload.sequenceChars = priorSequenceChars + droppedSequenceChars
  } else {
    recordDaemonStreamBacklogEvent('backgroundKeepTailDrop', {
      sessionIdSuffix: sessionId.slice(-10),
      droppedChars: dropped
    })
    batch.queue.splice(
      Math.max(0, insertGapAt),
      0,
      accountDaemonStreamEntry(batch, {
        sessionId,
        data: '',
        control: {
          type: 'event',
          event: 'dataGap',
          sessionId,
          payload: { droppedChars: dropped, sequenceChars: droppedSequenceChars }
        }
      })
    )
    insertGapAt = Math.max(0, insertGapAt) + 1
  }
  if (salvaged.length > 0) {
    // Deliver salvaged queries after the gap so programs waiting on their replies can proceed.
    const at = existingGap
      ? batch.queue.findIndex((e) => e.control === existingGap) + 1
      : insertGapAt
    batch.queue.splice(
      at,
      0,
      accountDaemonStreamEntry(batch, { sessionId, data: salvaged, sequenceChars: 0 })
    )
    batch.queuedChars += salvaged.length
    batch.queuedCharsBySession.set(
      sessionId,
      (batch.queuedCharsBySession.get(sessionId) ?? 0) + salvaged.length
    )
  }
}
