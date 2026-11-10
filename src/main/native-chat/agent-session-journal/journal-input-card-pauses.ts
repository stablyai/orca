import type { DerivedQueuePause } from './queued-messages/queued-message-pause'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  journalQueueStopHolds,
  type JournalQueuePauseMarks
} from './queued-messages/queued-message-pause-marks'

export function journalInputCardPauseInputs(
  epoch: string,
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number,
  floor: AgentJournalCursor | null
): readonly [
  JournalQueuePauseMarks['latestStop'],
  number,
  NonNullable<JournalQueuePauseMarks['cleared']> | null
] {
  const lifted = Math.max(latestAcceptedTurnSequence, marks.resumedSequence)
  const reopened = Math.max(marks.reopenedSequence, floor?.epoch === epoch ? floor.sequence : 0)
  return [
    journalQueueStopHolds(marks, latestAcceptedTurnSequence) ? marks.latestStop : null,
    reopened > lifted ? reopened : 0,
    marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted ? marks.cleared : null
  ]
}

export function journalInputCardPauses(
  epoch: string,
  [stop, reopened]: ReturnType<typeof journalInputCardPauseInputs>
): readonly DerivedQueuePause[] {
  return [
    ...(stop ? [{ reason: 'stopped' as const, since: { epoch, sequence: stop.sequence } }] : []),
    ...(reopened ? [{ reason: 'restarted' as const, since: { epoch, sequence: reopened } }] : [])
  ]
}
