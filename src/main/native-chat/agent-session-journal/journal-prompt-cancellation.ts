import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { partitionJournalLifecycleMutations } from './journal-lifecycle-batch-partition'
import { cancelledJournalPromptBody } from './journal-prompt-body-bounds'
import type { JournalReducerState } from './journal-reducer'
import { journalLifecycleBatchRowBuilder } from './journal-row-builders'
import type { JournalRowWriter } from './journal-row-writer'

export type JournalPromptCancellationInput = {
  prompts: readonly { itemId: string; expectedRevision: number }[]
  settlementId: string
  resolvedBy: string
  resolvedAt: number
  fence: number
}

/** Atomically revises only prompt revisions that still match the cancellation snapshot. */
export function cancelJournalPromptsAtRevisions(
  rowWriter: JournalRowWriter,
  state: () => JournalReducerState,
  input: JournalPromptCancellationInput
): Promise<number> {
  const identities = input.prompts.map((prompt) => parseAgentJournalItemKey(prompt.itemId))
  if (
    input.prompts.length === 0 ||
    new Set(input.prompts.map((prompt) => prompt.itemId)).size !== input.prompts.length ||
    identities.some((identity) => !identity)
  ) {
    return Promise.resolve(0)
  }
  return rowWriter
    .enqueueBatchIf((sequence, timestamp) => {
      const currentState = state()
      const mutations = input.prompts.flatMap((prompt, index) => {
        const resolved = currentState.aliases.get(prompt.itemId) ?? prompt.itemId
        const current = currentState.items.get(resolved)
        const identity = identities[index]
        if (
          !identity ||
          !current ||
          current.revision !== prompt.expectedRevision ||
          (current.body.kind !== 'approval' && current.body.kind !== 'question') ||
          current.body.resolution.state !== 'pending'
        ) {
          return []
        }
        const body = cancelledJournalPromptBody(current.body, {
          resolvedBy: input.resolvedBy,
          resolvedAt: input.resolvedAt,
          settlementId: input.settlementId
        })
        if (!body) {
          return []
        }
        return [
          {
            kind: 'item' as const,
            identity,
            body
          }
        ]
      })
      return partitionJournalLifecycleMutations(input.settlementId, mutations).map((chunk, index) =>
        journalLifecycleBatchRowBuilder(state, chunk.settlementId, chunk.mutations, {
          fence: input.fence
        })(sequence + index, timestamp)
      )
    })
    .then((rows) =>
      rows.reduce(
        (count, row) =>
          count +
          (row.kind === 'lifecycle-batch'
            ? row.mutations.filter((mutation) => mutation.kind === 'item').length
            : 0),
        0
      )
    )
}
