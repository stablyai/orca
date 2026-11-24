import type { AgentSessionPromptResult } from '../../../../shared/agent-session/agent-session-wire'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { CommandReceiptResult } from './command-receipt-schema'

export function promptRowAnswer(row: JournalRow | undefined): AgentSessionPromptResult {
  const body = row?.kind === 'item' ? row.body : undefined
  if (row?.kind !== 'item' || (body?.kind !== 'approval' && body?.kind !== 'question')) {
    throw new Error('an accepted prompt answer requires its prompt row')
  }
  return { itemId: row.itemId, revision: row.revision, resolution: body.resolution }
}

/** Capture replay data now so later revisions or rewind cannot change an accepted answer. */
export function promptAnswerReceipt(answer: AgentSessionPromptResult): CommandReceiptResult {
  const { state, selectedOptionId, answers, resolvedBy, resolvedAt } = answer.resolution
  if (state !== 'resolved') {
    throw new Error('an accepted prompt answer is resolved')
  }
  return {
    kind: 'prompt-answer',
    itemId: answer.itemId,
    revision: answer.revision,
    resolution: {
      state,
      selectedOptionId,
      ...(answers
        ? {
            answers: answers.map(({ questionId, optionIds, other }) => ({
              questionId,
              optionIds,
              ...(other === undefined ? {} : { other })
            }))
          }
        : {}),
      resolvedBy,
      resolvedAt
    }
  }
}
