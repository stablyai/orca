import type {
  AgentJournalSubmission,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'

import type { JournalLatestStop } from '../../agent-session-journal/context-epochs/journal-stop-turn-end'
import type { ResolveDispatchInput } from '../../agent-session-journal/journal-store-contracts'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

/** Finite synchronous evidence supplied to the pure recovery policies. */
export type UnopenedSendJournal = {
  statusRead?: () => {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  }
  inputOrder?: { recoverableSubmissions: () => AgentJournalSubmission[] }
  submission?: (clientMessageId: string) => AgentJournalSubmission | undefined
  agent?: AgentType
  queuedMessages?: { userStopInForce: () => JournalLatestStop | null }
  snapshot: () => { items: readonly AgentJournalRenderItem[] }
  submissions?: () => AgentJournalSubmission[]
  resolveDispatch?: (input: ResolveDispatchInput) => Promise<AgentJournalCursor | null>
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
