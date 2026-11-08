import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'

/** Output revisions cannot change queue eligibility; lifecycle and unknown changes still wake it. */
export function isJournalOutputRevision(state: JournalReducerState, row: JournalRow): boolean {
  if (row.kind !== 'item' || row.recovered) {
    return false
  }
  const previous = state.items.get(row.itemId)
  if (!previous || !sameRevisionPlacement(state, row, previous)) {
    return false
  }
  const before = previous.body
  const after = row.body
  if (before.kind === 'message' && after.kind === 'message') {
    return (
      (after.role === 'assistant' || after.role === 'reasoning') &&
      before.role === after.role &&
      before.sentAs === undefined &&
      after.sentAs === undefined &&
      before.command === undefined &&
      after.command === undefined &&
      before.from === undefined &&
      after.from === undefined &&
      before.state === after.state &&
      before.completedAt === after.completedAt &&
      before.blocks.every((block) => block.type === 'text') &&
      after.blocks.every((block) => block.type === 'text')
    )
  }
  if (before.kind === 'tool-call' && after.kind === 'tool-call') {
    const { output: _beforeOutput, ...beforeFields } = before
    const { output: _afterOutput, ...afterFields } = after
    return isDeepStrictEqual(beforeFields, afterFields)
  }
  return false
}

function sameRevisionPlacement(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'item' }>,
  previous: NonNullable<ReturnType<JournalReducerState['items']['get']>>
): boolean {
  const ownerFence = state.itemFences.get(row.itemId)
  return (
    (row.ownerFence ?? ownerFence) === ownerFence &&
    (row.executionOwner === undefined ||
      row.executionOwner === state.itemExecutionOwners.get(row.itemId)) &&
    (row.turnScope === undefined || isDeepStrictEqual(row.turnScope, previous.turnScope)) &&
    isDeepStrictEqual(agentJournalLinkageFields(row), agentJournalLinkageFields(previous))
  )
}
