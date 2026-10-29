import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Only streamed assistant text may skip per-commit fsync; FULL turn settlement makes it durable. */
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
    body.role !== 'assistant' ||
    !body.blocks.every((block) => block.type === 'text') ||
    body.sentAs !== undefined ||
    body.command !== undefined ||
    body.from !== undefined ||
    previous?.body.kind !== 'message' ||
    previous.body.role !== 'assistant' ||
    previous.body.sentAs !== undefined ||
    previous.body.command !== undefined ||
    previous.body.from !== undefined ||
    !previous.body.blocks.every((block) => block.type === 'text')
  ) {
    return false
  }
  const ownerFence = state.itemFences.get(row.itemId)
  return (
    (row.ownerFence ?? ownerFence) === ownerFence &&
    (row.executionOwner === undefined ||
      row.executionOwner === state.itemExecutionOwners.get(row.itemId)) &&
    (row.turnScope === undefined || isDeepStrictEqual(row.turnScope, previous.turnScope)) &&
    isDeepStrictEqual(agentJournalLinkageFields(row), agentJournalLinkageFields(previous))
  )
}
