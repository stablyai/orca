import { extendAgentSessionTextSource } from '../agent-session-wire/agent-session-text-encoding'
import type { JournalReducerState } from './journal-reducer'
import type { JournalTextDeltaRow } from './journal-text-rows'
import { journalTextField, withJournalText } from './journal-text-rows'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { upsertJournalItem } from './journal-item-fold'
import { observeJournalProviderActivity } from './journal-provider-activity'
import { journalItemExecutionFence } from './journal-item-provenance'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'

export function applyJournalTextDelta(
  state: JournalReducerState,
  row: JournalTextDeltaRow,
  savedAt: number
): void {
  const itemId = state.aliases.get(row.itemId) ?? row.itemId
  const previous = state.items.get(itemId)
  if (journalItemRevisionIsStale(state, itemId, row.revision)) {
    return
  }
  const text = previous ? journalTextField(previous.body, row.field) : null
  if (!previous || text === null) {
    throw new Error('journal_text_creating_field_missing')
  }
  const incomplete =
    state.replayTextDebt?.has(itemId) ||
    previous.revision !== row.predecessor ||
    text.length !== row.baseLength
  if (incomplete) {
    if (
      !state.replayTextDebt ||
      state.textIndex.sparseAfter === null ||
      row.seq <= state.textIndex.sparseAfter
    ) {
      throw new Error('journal_text_predecessor_missing')
    }
    if (!state.replayTextDebt.has(itemId)) {
      state.replayTextDebt.set(itemId, row.seq)
    }
  }
  upsertJournalItem(
    state,
    itemId,
    row.revision,
    {
      ...previous,
      ...agentJournalLinkageFields(row),
      revision: row.revision,
      body: incomplete
        ? previous.body
        : withJournalText(previous.body, row.field, text + row.suffix)
    },
    { fence: row.fence, ownerFence: row.ownerFence, executionOwner: row.executionOwner },
    state.textPolicy.has(itemId)
      ? extendAgentSessionTextSource(state.textPolicy.get(itemId), row.suffix)
      : undefined
  )
  state.textIndex.delta({ ...row, itemId })
  observeJournalProviderActivity(
    state,
    row,
    row.itemId,
    previous.body,
    savedAt,
    journalItemExecutionFence(state, itemId) ?? row.fence
  )
}
