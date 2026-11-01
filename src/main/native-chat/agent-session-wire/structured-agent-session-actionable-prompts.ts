import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  JournalItemRow,
  JournalTombstoneRow,
  JournalLifecycleMutation
} from '../agent-session-journal/journal-row-schema'

export type PromptProjection = {
  epoch: string
  sequence: number
  fence: number | null
  items: AgentJournalRenderItem[]
  dependencies: Set<string>
}

export function reusePromptProjection(
  journal: Partial<Pick<AgentSessionJournal, 'readSince' | 'item'>>,
  prior: PromptProjection | undefined,
  cursor: Pick<PromptProjection, 'epoch' | 'sequence'>,
  liveFence: number | null
): AgentJournalRenderItem[] | undefined {
  if (
    prior?.epoch === cursor.epoch &&
    prior.sequence === cursor.sequence &&
    prior.fence === liveFence
  ) {
    return prior.items
  }
  if (prior?.epoch === cursor.epoch && prior.fence === liveFence && journal.readSince) {
    const delta = journal.readSince(prior, 200)
    const touches = (
      change: JournalItemRow | JournalTombstoneRow | JournalLifecycleMutation
    ): boolean =>
      prior.dependencies.has(change.itemId) ||
      (change.kind === 'item' &&
        (change.body.kind === 'approval' || change.body.kind === 'question'))
    const outcomeTouches = (itemId: string): boolean => {
      if (!journal.item || prior.dependencies.has(itemId)) {
        return true
      }
      const body = journal.item(itemId)?.body
      return body?.kind === 'approval' || body?.kind === 'question'
    }
    if (
      delta.ok &&
      delta.cursor.sequence === cursor.sequence &&
      delta.rows.at(-1)?.seq === cursor.sequence &&
      delta.rows.every((row, index) =>
        row.kind === 'outcome'
          ? row.submissionIds.length === 0 && !row.itemIds.some(outcomeTouches)
          : row.seq === prior.sequence + index + 1 &&
            (row.kind === 'lifecycle-batch'
              ? !row.mutations.some(touches)
              : (row.kind === 'item' || row.kind === 'tombstone') && !touches(row))
      )
    ) {
      prior.sequence = cursor.sequence
      return prior.items
    }
  }
  return undefined
}
