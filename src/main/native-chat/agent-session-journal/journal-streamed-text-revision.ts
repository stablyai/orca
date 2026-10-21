import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/**
 * A later revision of an assistant message that changes only its content. An OS crash that loses
 * it loses streamed text and nothing else: no send, approval, stop, ownership or turn fact rides
 * it, and a turn's settlement is written FULL after it, which makes it durable. Everything else
 * keeps the per-commit fsync.
 */
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
