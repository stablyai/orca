// Which unanswered sends a person's Stop takes back as never sent, when Codex takes it or the child
// ends, read from the journal at the settlement that lands, so a retried settle reads the same rows.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../shared/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** What the derivation reads; absent members (a narrow double) withdraw nothing. */
export type UnopenedSendJournal = {
  agent?: AgentType
  queuedMessages?: Pick<AgentSessionJournal['queuedMessages'], 'userStopInForce'>
  snapshot: () => Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  submissions?: () => (Pick<
    AgentJournalSubmission,
    | 'clientMessageId'
    | 'dispatchState'
    | 'recovered'
    | 'handoverRecorded'
    | 'handedOverAt'
    | 'acceptedSequence'
  > & { reason?: string | null; fence?: number })[]
  resolveDispatch?: AgentSessionJournal['resolveDispatch']
}

/** A send a dying child can take back: one still being handed over, or one this process left in
 *  doubt (its answer was lost). Never a queued card's, nor a send an earlier process left behind. */
export function sendStopCanTakeBack(
  entry: Pick<
    AgentJournalSubmission,
    'dispatchState' | 'recovered' | 'handoverRecorded' | 'handedOverAt'
  >
): boolean {
  return (
    !isQueuedAgentJournalSubmission(entry) &&
    (entry.dispatchState === 'pending' ||
      (entry.dispatchState === 'unknown' && entry.recovered !== true))
  )
}
