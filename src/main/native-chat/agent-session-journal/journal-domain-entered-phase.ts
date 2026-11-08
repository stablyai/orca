import type Database from '../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'

/** Entered order survives pending/unknown refreshes independently of sending order. */
export function journalDomainEnteredPhaseOrdinal(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  previous: number | null,
  submission: AgentJournalSubmission
): number | null {
  if (
    (submission.dispatchState !== 'pending' && submission.dispatchState !== 'unknown') ||
    isQueuedAgentJournalSubmission(submission)
  ) {
    return null
  }
  if (previous !== null) {
    return previous
  }
  const tail = db
    .prepare(`SELECT entered_phase_ordinal FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND entered_phase_ordinal IS NOT NULL
    ORDER BY entered_phase_ordinal DESC,message_id DESC LIMIT 1`)
    .get(target.sessionId, target.epoch)
  return Number(tail?.entered_phase_ordinal ?? 0) + 1
}
