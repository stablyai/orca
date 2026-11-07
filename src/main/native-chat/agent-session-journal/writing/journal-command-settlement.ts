import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from '../projection/journal-reducer'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import type { JournalCommandSettlementInput } from '../journal-store-contracts'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'

/** Dispatch settles first; a later lifecycle failure leaves the send settled, as before. */
export async function settleJournalCommand(
  deps: {
    state: () => JournalReducerState
    writer: JournalRowWriter
    lifecycle: JournalLifecycleBatchAppender
    now: () => number
  },
  input: JournalCommandSettlementInput
): Promise<void> {
  const { dispatch } = input
  const turn = structuredAgentSessionCommandTurn(dispatch.clientMessageId)
  await deps.writer.append(journalDispatchRowBuilder(deps.state, dispatch))
  await deps.lifecycle.appendPlanned({
    settlementId: `command-settled:${dispatch.clientMessageId}`,
    fence: dispatch.fence,
    plan: () => {
      const running = readAgentJournalTurn(readJournalInputItem(deps.state(), turn.itemId)?.body)
      if (running?.state !== 'running') {
        return { mutations: [], dispatches: [] }
      }
      return {
        dispatches: [],
        mutations: [
          ...(dispatch.state === 'rejected' && input.failureBody
            ? [
                {
                  kind: 'item' as const,
                  identity: turn.resultIdentity,
                  body: input.failureBody,
                  turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
                }
              ]
            : []),
          {
            kind: 'item',
            identity: turn.identity,
            body: agentJournalTurnBody({
              ...running,
              ...(dispatch.state === 'rejected'
                ? { state: 'completed', outcome: 'failure', completedAt: deps.now() }
                : { state: 'unverifiable' })
            }),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      }
    }
  })
}
