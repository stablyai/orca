import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
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

export const promptProjections = new WeakMap<object, PromptProjection>()

export function reusePromptProjection(
  _journal: Pick<AgentSessionJournal, 'cursor'>,
  prior: PromptProjection | undefined,
  cursor: Pick<PromptProjection, 'epoch' | 'sequence'>,
  liveFence: number | null
): AgentJournalRenderItem[] | undefined {
  return prior?.epoch === cursor.epoch &&
    prior.sequence === cursor.sequence &&
    prior.fence === liveFence
    ? prior.items
    : undefined
}

/** Advance the existing prompt cache from published commits, without a native history read. */
export function advancePromptProjection(
  journal: Pick<AgentSessionJournal, 'cursor'>,
  rows?: readonly JournalRow[]
): void {
  const prior = promptProjections.get(journal)
  if (!prior) {
    return
  }
  const cursor = journal.cursor()
  const touches = (
    change: JournalItemRow | JournalTombstoneRow | JournalLifecycleMutation
  ): boolean =>
    prior.dependencies.has(change.itemId) ||
    (change.kind === 'item' && (change.body.kind === 'approval' || change.body.kind === 'question'))
  if (
    rows &&
    prior.epoch === cursor.epoch &&
    (rows.at(-1)?.seq ?? prior.sequence) === cursor.sequence &&
    rows.every(
      (row, index) =>
        row.seq === prior.sequence + index + 1 &&
        (row.kind === 'lifecycle-batch'
          ? !row.mutations.some(touches)
          : (row.kind === 'item' || row.kind === 'tombstone') && !touches(row))
    )
  ) {
    prior.sequence = cursor.sequence
  } else {
    promptProjections.delete(journal)
  }
}
