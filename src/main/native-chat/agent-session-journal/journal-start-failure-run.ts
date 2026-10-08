// One row speaks for a run of starts that fail alike. Until a turn is delivered, a start that fails
// as the chat's latest start-failure row says writes no row of its own, and its rejected message is
// read under that row. Decided on the journal's lane, from the fold every earlier write landed in,
// as the batch carrying the row is planned; nothing marks the run.

import {
  readAgentSessionFailureFact,
  sameAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  isStructuredAgentSessionCommandStartFailureRow,
  isStructuredAgentSessionStartFailureRow
} from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-row-builders'

/** A batch's mutations less any start-failure row whose failure its run's row already states. */
export function withoutRestatedStartFailureRows(
  state: Pick<JournalReducerState, 'items' | 'latestAcceptedSequence'>,
  mutations: readonly JournalLifecycleMutationInput[]
): readonly JournalLifecycleMutationInput[] {
  return mutations.filter((mutation) => {
    if (mutation.kind !== 'item' || mutation.body.kind !== 'status') {
      return true
    }
    const itemId = agentJournalItemKey(mutation.identity)
    if (
      !isStructuredAgentSessionStartFailureRow(itemId) ||
      // A command's failed start always says so: a client that hides its message has only this.
      isStructuredAgentSessionCommandStartFailureRow(itemId, (id) => state.items.get(id)?.body)
    ) {
      return true
    }
    const fact = readAgentSessionFailureFact(mutation.body.failure)
    return fact === undefined || !journalStartFailureAlreadyStated(state, fact)
  })
}

/** Whether the latest start-failure row states this failure, with no turn delivered since. */
function journalStartFailureAlreadyStated(
  state: Pick<JournalReducerState, 'items' | 'latestAcceptedSequence'>,
  failure: AgentSessionFailureFact
): boolean {
  let latest: AgentJournalRenderItem | undefined
  for (const item of state.items.values()) {
    if (
      isStructuredAgentSessionStartFailureRow(item.itemId) &&
      (latest === undefined || item.sequence > latest.sequence)
    ) {
      latest = item
    }
  }
  const stated =
    latest?.body.kind === 'status' ? readAgentSessionFailureFact(latest.body.failure) : undefined
  return (
    latest !== undefined &&
    stated !== undefined &&
    sameAgentSessionFailureFact(stated, failure) &&
    // A command's row names the command's next step, so it starts no run for a message.
    !isStructuredAgentSessionCommandStartFailureRow(
      latest.itemId,
      (id) => state.items.get(id)?.body
    ) &&
    // Any send accepted after the row, a command too, ends its run: the next failure is news.
    state.latestAcceptedSequence < latest.sequence
  )
}
