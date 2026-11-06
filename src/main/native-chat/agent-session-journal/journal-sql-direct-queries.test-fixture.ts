import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { memoryJournalMap } from './journal-memory-collections'
import { journalControlStateEntries } from './journal-sql-control-export'
import type { JournalReducerState } from './journal-reducer'
import type { DirectJournalRecord } from './journal-sql-direct-values.test-fixture'

export function* directJournalQueryFacts(
  state: JournalReducerState
): Generator<DirectJournalRecord> {
  const ordinals = [...journalControlStateEntries(state)].find(
    (entry) => entry.path.join('.') === 'order.evidenceFacts.ordinals'
  )?.value
  if (!(ordinals instanceof Map)) {
    throw new Error('Missing direct journal submission ordinals')
  }
  let ordinal = 0
  for (const [id, send] of memoryJournalMap(state.submissions)) {
    ordinal++
    const itemId = agentJournalSubmissionKey(id)
    const item = state.items.get(itemId)
    yield {
      table: 'submissions',
      values: [
        JSON.stringify(id),
        JSON.stringify(itemId),
        ordinals.get(id) ?? ordinal,
        send.payloadFingerprint ?? null,
        send.submittedAt,
        send.acceptedSequence ?? null,
        send.dispatchState,
        Number(isWriteFailureSubmission(send)),
        Number(state.inputs.echoes.has(itemId)),
        Number(!!item),
        item?.sequence ?? 0,
        Number(item?.turnScope?.kind !== 'turn')
      ]
    }
  }
  ordinal = 0
  for (const [id, send] of memoryJournalMap(state.inputs.candidates)) {
    ordinal++
    const handover = state.inputs.handovers.get(id)
    const source = state.inputs.sources.get(id)
    yield {
      table: 'input_candidates',
      values: [
        JSON.stringify(id),
        ordinal,
        handover?.fence ?? source?.fence ?? send.fence,
        handover?.fence ?? null
      ]
    }
  }
  ordinal = 0
  for (const [key, value] of memoryJournalMap(state.aliases)) {
    yield { table: 'aliases', values: [JSON.stringify(key), JSON.stringify(value), ++ordinal] }
  }
  for (const [key, entry] of memoryJournalMap(state.inputEntries)) {
    yield { table: 'native_entries', values: [JSON.stringify(key), entry.context.basis] }
  }
}
