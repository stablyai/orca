import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import type {
  JournalDomainSubmissionAttempt,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'

/** The failed-turn pause in force, which a person's otherwise-immediate send passes; the card an
 *  account move turns that send into records it, so only that failure lets the card through. */
export function accountMoveFailureWitness(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  reopenFloor: AgentJournalCursor | null
): AgentJournalCursor | undefined {
  return (
    readJournalDomainQueuePauseContext(db, target, reopenFloor, []).pauses.find(
      (pause) => pause.reason === 'failed'
    )?.since ?? undefined
  )
}

/** A send kept back from the old account passed the failure only when the person sent it directly
 *  (not from a card) after that failure. */
export function keptSendFailureWitness(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  attempt: Pick<JournalDomainSubmissionAttempt, 'admittedPersonal' | 'admission'>,
  submission: Pick<AgentJournalSubmission, 'submittedSequence'>
): AgentJournalCursor | undefined {
  if (!attempt.admittedPersonal || attempt.admission.familyId !== null) {
    return undefined
  }
  const witness = accountMoveFailureWitness(db, target, null)
  return witness && witness.sequence < (submission.submittedSequence ?? 0) ? witness : undefined
}
