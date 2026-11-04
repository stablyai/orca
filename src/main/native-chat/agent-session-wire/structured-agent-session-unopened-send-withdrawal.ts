import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
// Derive withdrawals at settlement execution so retries read the same landed journal state.

/** Missing methods withdraw nothing. */
export type UnopenedSendJournal = {
  statusRead?: AgentSessionJournal['statusRead']
  inputOrder?: Pick<AgentSessionJournal['inputOrder'], 'recoverableSubmissions'>
  submission?: AgentSessionJournal['submission']
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

/** Only in-flight or locally unknown sends; never unhanded cards or recovered sends from an earlier process. */
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
