import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import {
  journalQueueStopHolds,
  failedQueueTurnSequence,
  type DerivedQueuePause
} from './queued-message-pause'

export function journalInputCardPauses(
  state: JournalReducerState,
  floor: { epoch: string; sequence: number } | null
) {
  const marks = state.queuePauseMarks
  const failed =
    failedQueueTurnSequence(journalInputOrder(state).newestTurn.failure(), marks.resumedSequence) >
    0
  const lifted = Math.max(state.latestAcceptedTurnSequence, marks.resumedSequence)
  const reopened = Math.max(
    marks.reopenedSequence,
    floor?.epoch === state.epoch ? floor.sequence : 0
  )
  const pauseInputs = [
    journalQueueStopHolds(marks, state.latestAcceptedTurnSequence) ? marks.latestStop : null,
    reopened > lifted ? reopened : 0,
    marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted ? marks.cleared : null
  ]
  const pauses: readonly DerivedQueuePause[] = [
    ...(pauseInputs[0] && marks.latestStop
      ? [
          {
            reason: 'stopped' as const,
            since: { epoch: state.epoch, sequence: marks.latestStop.sequence }
          }
        ]
      : []),
    ...(pauseInputs[1]
      ? [{ reason: 'restarted' as const, since: { epoch: state.epoch, sequence: reopened } }]
      : [])
  ]
  return { failed, pauseInputs, pauses }
}
