import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'

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
  return sameRevisionPlacement(state, row, previous)
}

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
