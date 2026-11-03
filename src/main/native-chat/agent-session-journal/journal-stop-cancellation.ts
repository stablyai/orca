import type { JournalStopEvent } from './journal-row-schema'

/** A personal Stop or close still waiting for its turn to end. Saved with the pause marks. */
export type PendingCancellation = { sequence: number; event: JournalStopEvent }

type StopMarks = {
  latestStop: { sequence: number; event: JournalStopEvent } | null
  pendingCancellations?: PendingCancellation[]
}

function isPersonal(reason: JournalStopEvent['reason']): boolean {
  return reason === 'user-stop' || reason === 'user-close'
}

/** One open fact per turn. A later close for the same turn replaces the earlier one. */
export function recordPendingCancellation(marks: StopMarks, recorded: PendingCancellation): void {
  const turnId = recorded.event.turnId
  const kept = (marks.pendingCancellations ?? []).filter((entry) => entry.event.turnId !== turnId)
  marks.pendingCancellations = [...kept, recorded]
}

/** The turn's outcome now carries the cancellation, so the pending fact is done. */
export function retirePendingCancellation(marks: StopMarks, turnId: string): void {
  const kept = (marks.pendingCancellations ?? []).filter((entry) => entry.event.turnId !== turnId)
  if (kept.length === 0) {
    delete marks.pendingCancellations
    return
  }
  marks.pendingCancellations = kept
}

/** Keep the queue's Stop, and keep every named personal Stop that it replaces. */
export function noteHeldStop(
  marks: StopMarks,
  row: { seq: number; stopEvent: JournalStopEvent },
  replacesPause: boolean
): void {
  if (replacesPause) {
    const previous = marks.latestStop
    if (previous?.event.turnId !== undefined && isPersonal(previous.event.reason)) {
      recordPendingCancellation(marks, { sequence: previous.sequence, event: previous.event })
    }
    marks.latestStop = { sequence: row.seq, event: row.stopEvent }
    return
  }
  if (isPersonal(row.stopEvent.reason)) {
    recordPendingCancellation(marks, { sequence: row.seq, event: row.stopEvent })
  }
}
