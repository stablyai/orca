import type Database from '../../../sqlite/sync-database'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  AgentSessionRefusalError,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { journalContextEpoch } from '../context-epochs/journal-context-epoch'
import { journalPersonalStopAfter } from '../context-epochs/journal-personal-stop-frontier'
import { refreshJournalPersonalStops } from '../context-epochs/journal-personal-stop'
import { journalInputOrder } from '../input-order/journal-input-order'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalOpenRefusalError } from '../replay/journal-open-failure'

/** Called inside the submission transaction, before any answer or acceptance is written. */
export function validateJournalDormantAnswer(
  db: Database.Database,
  state: JournalReducerState,
  answer: { itemId: string; expectedRevision: number; contextEpoch: string },
  refreshed: () => void
): void {
  const previous = state.personalStops
  try {
    refreshJournalPersonalStops(db, state)
  } catch (error) {
    throw journalOpenRefusalError(error)
  }
  if (state.personalStops !== previous) {
    queueMicrotask(refreshed)
  }
  const context = journalContextEpoch(state.epoch, state.contextBoundary)
  const item = state.items.get(answer.itemId)
  if (
    context !== answer.contextEpoch ||
    !item ||
    item.revision !== answer.expectedRevision ||
    (item.body.kind !== 'approval' && item.body.kind !== 'question') ||
    item.body.resolution.state !== 'pending' ||
    item.sequence < journalInputOrder(state).latestPersonAcceptedSequence() ||
    item.sequence < state.contextBoundary
  ) {
    throw ended()
  }
  const turn =
    item.turnScope?.kind === 'turn'
      ? readAgentJournalTurn(state.items.get(item.turnScope.turnItemId)?.body)
      : undefined
  const after = { sequence: item.sequence, at: item.observedAt, turnId: turn?.turnId }
  const evidence = journalPersonalStopAfter(state.personalStops, after)
  if (evidence === 'stopped') {
    throw ended()
  }
  if (evidence === 'unknown') {
    throw journalOpenRefusalError(new Error('the saved question retirement history is unavailable'))
  }
}

function ended(): AgentSessionRefusalError {
  return new AgentSessionRefusalError(
    refuse(
      'agent_session_operation_invalid',
      { reason: 'promptOwnerEnded' },
      'This question is no longer waiting for an answer.'
    )
  )
}
