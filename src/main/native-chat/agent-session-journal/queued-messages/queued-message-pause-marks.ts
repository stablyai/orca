import type { JournalStopEvent, JournalTombstoneRow } from '../durable-rows/journal-row-schema'

/** Memory-only unnamed Stop binding; failedOn affects display, never cancellation ownership. */
export type JournalStopSettle = {
  settling: boolean
  turnId?: string
  failedOn?: JournalStopFailedOn
}

export type JournalStopFailedOn = { turnId: string } | { openedAfter: number }

export type JournalQueuePauseMarks = {
  cleared?: { sequence: number; operationId: string; messageIds: readonly string[]; lifted?: true }
  latestStop: { sequence: number; event: JournalStopEvent; settle?: JournalStopSettle } | null
  /** Absent only in older layouts; end-attribution stays on latestStop. */
  manualStop?: { sequence: number; event: JournalStopEvent & { reason: 'user-stop' } } | null
  /** Zero means absent. */
  resumedSequence: number
  /** Zero means absent. */
  reopenedSequence: number
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
}

function isReadableStopEvent(value: unknown): value is JournalStopEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    'at' in value &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  )
}

export function foldJournalQueuePauseMark(
  marks: JournalQueuePauseMarks,
  row: JournalTombstoneRow
): void {
  if (isReadableStopEvent(row.stopEvent)) {
    marks.latestStop = { sequence: row.seq, event: row.stopEvent }
    if (marks.manualStop !== undefined && row.stopEvent.reason === 'user-stop') {
      marks.manualStop = { sequence: row.seq, event: { ...row.stopEvent, reason: 'user-stop' } }
    }
  } else if (row.queueResume === true) {
    marks.resumedSequence = row.seq
  } else if (row.queueReopen === true) {
    // Late reopen marks must not narrow earlier boundaries.
    const since = row.queueReopenSince
    const start = typeof since === 'number' && since > 0 && since <= row.seq ? since : row.seq
    marks.reopenedSequence = Math.max(marks.reopenedSequence, start)
  } else if (isReadableQueueClear(row.queueClear)) {
    marks.cleared = { ...row.queueClear, sequence: row.seq }
  }
}

function isReadableQueueClear(
  value: unknown
): value is NonNullable<JournalTombstoneRow['queueClear']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    'messageIds' in value &&
    Array.isArray(value.messageIds) &&
    value.messageIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    (!('lifted' in value) || value.lifted === true)
  )
}

/** Older layouts retain only their final interruption; superseded historical Stops stay superseded. */
export function journalManualStop(
  marks: JournalQueuePauseMarks
): JournalQueuePauseMarks['latestStop'] {
  return marks.manualStop === undefined
    ? marks.latestStop?.event.reason === 'user-stop'
      ? marks.latestStop
      : null
    : marks.manualStop
}

export function journalQueueStopHolds(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): boolean {
  const stop = journalManualStop(marks)
  return (
    stop !== null && stop.sequence > Math.max(latestAcceptedTurnSequence, marks.resumedSequence)
  )
}

export function journalUserStopInForce(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): JournalQueuePauseMarks['latestStop'] {
  return journalQueueStopHolds(marks, latestAcceptedTurnSequence) ? journalManualStop(marks) : null
}
