import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Only same-role streamed text may skip per-commit fsync; FULL turn settlement makes it durable. */
export function isJournalStreamedTextRevision(
  state: JournalReducerState,
  row: JournalRow
): boolean {
  if (row.kind !== 'item' || row.recovered) {
    return false
  }
  const { body } = row
  const previous = state.items.get(row.itemId)
  if (
    body.kind !== 'message' ||
    (body.role !== 'assistant' && body.role !== 'reasoning') ||
    !body.blocks.every((block) => block.type === 'text') ||
    body.sentAs !== undefined ||
    body.command !== undefined ||
    body.from !== undefined ||
    previous?.body.kind !== 'message' ||
    previous.body.role !== body.role ||
    previous.body.sentAs !== undefined ||
    previous.body.command !== undefined ||
    previous.body.from !== undefined ||
    !previous.body.blocks.every((block) => block.type === 'text')
  ) {
    return false
  }
  // Only text changes qualify; reasoning state changes keep FULL durability.
  const ownerFence = state.itemFences.get(row.itemId)
  return (
    isDeepStrictEqual(
      { ...body, blocks: body.blocks.map((block) => ({ ...block, text: '' })) },
      { ...previous.body, blocks: previous.body.blocks.map((block) => ({ ...block, text: '' })) }
    ) &&
    (row.ownerFence ?? ownerFence) === ownerFence &&
    (row.executionOwner === undefined ||
      row.executionOwner === state.itemExecutionOwners.get(row.itemId)) &&
    (row.turnScope === undefined || isDeepStrictEqual(row.turnScope, previous.turnScope)) &&
    isDeepStrictEqual(agentJournalLinkageFields(row), agentJournalLinkageFields(previous))
  )
}
