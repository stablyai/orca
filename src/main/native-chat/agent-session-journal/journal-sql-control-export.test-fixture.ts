import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { journalOutcomeScalars } from './journal-outcome-codec'
import { journalOutcomeScalarJson } from './journal-outcome-scalars'

export function journalSqlControlSnapshot(state: JournalReducerState) {
  const order = journalInputOrder(state)
  order.cards.ensure(state)
  return {
    scalars: Object.fromEntries(
      Object.entries(journalOutcomeScalars(state)).map(([key, value]) => [
        key,
        journalOutcomeScalarJson(value)
      ])
    ),
    firstQueued: order.firstQueued()?.clientMessageId,
    explicit: order.explicitSend()?.clientMessageId,
    entered: [...order.enteredSubmissions()].map((send) => send.clientMessageId),
    unsettled: order.unsettledSubmissions().map((send) => send.clientMessageId),
    sending: order.sendingSubmissions().map((send) => send.clientMessageId),
    inputs: ['send', 'second', 'first', 'retry'].map((id) => ({
      id,
      predecessors: order.predecessors(state, id),
      original: order.familyOriginal(id)?.clientMessageId,
      linked: [...order.linkedTo(id)].map((send) => send.clientMessageId),
      ended: state.inputs.ended.has(id),
      submission: state.submissions.get(id),
      receipt: state.receipts.get(id)
    })),
    cards: ['q', 'command', 'ordinary', 'foreign'].map((id) => {
      const card = state.queue.cards.get(id)
      return [id, card, card ? order.paused(state, card, null) : null]
    }),
    head: order.head(state, null)?.messageId ?? null,
    bounds: order.cardBounds(state),
    newest: state.queries.newestTurnBySequence(state),
    candidates: state.queries.candidatesForFence(state, 1).map((send) => send.clientMessageId),
    returned: [...state.queries.returnedCommandIds(state)],
    newestFailure: order.newestTurn.failure()
  }
}
