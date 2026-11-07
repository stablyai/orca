import type { JournalReducerState } from './projection/journal-reducer'
import { memoryJournalMap } from './journal-memory-collections'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalInputPresentationMember } from './input-order/journal-input-obligations'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { classifyDispatchRejection } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

export function memoryHasStatusRequestItem(state: JournalReducerState): boolean {
  const submitted = new Set(
    [...memoryJournalMap(state.submissions).keys()].map(agentJournalSubmissionKey)
  )
  return [...memoryJournalMap(state.items).values()].some(
    (item) =>
      journalInputPresentationMember(state, item.itemId) &&
      (readAgentJournalTurn(item.body) !== null ||
        (item.body.kind === 'message' &&
          (item.body.role === 'assistant' ||
            (item.body.role === 'user' && !submitted.has(item.itemId)))))
  )
}

export function memoryFailedStatusItems(
  state: JournalReducerState,
  floor: number
): Iterable<JournalStatusItem> {
  const rejected = new Set(
    [...memoryJournalMap(state.submissions).values()]
      .filter(
        (send) =>
          send.dispatchState === 'rejected' &&
          (!floor || (send.acceptedSequence ?? 0) > floor) &&
          classifyDispatchRejection(send).verdict === 'failure'
      )
      .map((send) => agentJournalSubmissionKey(send.clientMessageId))
  )
  const rows: JournalStatusItem[] = []
  let ordinal = 0
  for (const item of memoryJournalMap(state.items).values()) {
    const position = {
      sequence: item.sequence,
      sequenceIndex: item.sequenceIndex ?? 0,
      ordinal: ordinal++
    }
    if (
      rejected.has(item.itemId) &&
      (!floor || item.sequence > floor) &&
      journalInputPresentationMember(state, item.itemId) &&
      isRootAgentJournalItem(item)
    ) {
      rows.push({ item, position })
    }
  }
  return rows.sort((a, b) => compareJournalStatusPositions(b.position, a.position))
}
