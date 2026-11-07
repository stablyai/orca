import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  agentSessionStoppedHistoryOwed,
  selectStoppedHistory,
  type StoppedHistoryDelivery
} from '../../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import type { JournalHandoverInput } from '../journal-store-contracts'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalInputOrder } from '../input-order/journal-input-order'
import { journalInputSourceBody } from '../input-order/journal-input-source'
import { journalDispatchRowBuilder } from '../writing/journal-row-builders'
import type { JournalRowWriter } from '../writing/journal-row-writer'

/** Select and claim the carried messages at the handover row's write position. */
export async function prepareJournalHandover(
  deps: { state: () => JournalReducerState; rowWriter: JournalRowWriter },
  input: JournalHandoverInput
): Promise<StoppedHistoryDelivery | null> {
  let carried: StoppedHistoryDelivery | null = null
  await deps.rowWriter.append((seq, ts) => {
    carried = selectJournalHandoverHistory(deps.state(), input)
    return journalDispatchRowBuilder(deps.state, {
      clientMessageId: input.clientMessageId,
      state: 'pending',
      fence: input.fence,
      turnScope: input.turnScope,
      carries: carried?.covers ?? []
    })(seq, ts)
  })
  return carried
}

function selectJournalHandoverHistory(
  state: JournalReducerState,
  { clientMessageId, turnScope, body }: JournalHandoverInput
): StoppedHistoryDelivery | null {
  const submission = state.submissions.get(clientMessageId)
  if (
    turnScope.kind !== 'thread' ||
    !submission ||
    !agentSessionSendDeliversStoppedHistory(submission, body) ||
    !agentSessionSendCarriesStoppedHistory(body)
  ) {
    return null
  }
  const clearSequence = state.queries.latestContextClearSequence(state)
  return selectStoppedHistory(
    agentSessionStoppedHistoryOwed({
      submissions: journalInputOrder(state).stoppedHistoryInputs(clientMessageId, clearSequence),
      carried: new Map(),
      clearSequence,
      body: (id) => journalInputSourceBody(state.inputs.sources.get(id))
    }),
    body
  )
}
