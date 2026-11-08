import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalStartFailureSettlementInput } from '../journal-store-contracts'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLifecycleMutationInput } from './journal-lifecycle-mutation'

/** Deduplicate durable failure by child generation, or oldest opening message if no child published. */
export function journalStartFailureRow(
  startKey: string,
  words: AgentJournalDispatchRejection
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

/** Earlier delivery or settlement must win over a stale failed-start report. */
export async function settleJournalStartFailure(
  state: () => JournalReducerState,
  lifecycle: Pick<JournalLifecycleBatchAppender, 'appendPlanned'>,
  input: JournalStartFailureSettlementInput
): Promise<void> {
  const { startKey, clientMessageId, fence, reason, rejection } = input
  await lifecycle.appendPlanned({
    settlementId: `start-failure:${startKey}`,
    keepFailedStart: true,
    fence,
    recovered: true,
    plan: () => {
      if (clientMessageId !== null) {
        const selected = state().submissions.get(clientMessageId)
        if (!selected || !isQueuedAgentJournalSubmission(selected)) {
          return { mutations: [], dispatches: [] }
        }
      }
      return {
        mutations: [journalStartFailureRow(startKey, input)],
        dispatches:
          clientMessageId === null
            ? []
            : [
                {
                  clientMessageId,
                  fence,
                  state: 'rejected' as const,
                  recovered: true,
                  reason,
                  rejection
                }
              ]
      }
    }
  })
}
