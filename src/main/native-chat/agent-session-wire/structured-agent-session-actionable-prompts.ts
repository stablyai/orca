import { sortJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import type {
  StructuredAgentSessionCurrentWorkJournal,
  StructuredAgentSessionCurrentWork
} from './structured-agent-session-current-work'
import type {
  JournalRow,
  JournalItemRow,
  JournalTombstoneRow,
  JournalLifecycleMutation
} from '../agent-session-journal/journal-row-schema'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

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

export function* prepareActionablePromptSteps(
  journal: StructuredAgentSessionCurrentWorkJournal,
  work: Pick<StructuredAgentSessionCurrentWork, 'liveFence' | 'isCurrentItem'>,
  current?: () => boolean
): Generator<void, AgentJournalRenderItem[]> {
  const cursor = journal.cursor()
  const prior = promptProjections.get(journal)
  const reusable = reusePromptProjection(journal, prior, cursor, work.liveFence)
  if (reusable) {
    return reusable
  }
  const dependencies = new Set<string>()
  const items: AgentJournalRenderItem[] = []
  const visit: Parameters<typeof journal.visitItems>[0] = (itemId, _sequence, body) => {
    if (
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
    ) {
      const item = journal.item(itemId)
      dependencies.add(itemId)
      if (item?.turnScope?.kind === 'turn') {
        dependencies.add(item.turnScope.turnItemId)
        const turn = readAgentJournalTurn(journal.item(item.turnScope.turnItemId)?.body)
        if (turn?.userItemId) {
          dependencies.add(turn.userItemId)
        }
      }
      if (item && work.isCurrentItem(itemId)) {
        items.push(item)
      }
    }
  }
  if (current && journal.visitItemSteps) {
    yield* journal.visitItemSteps(visit)
  } else {
    journal.visitItems(visit)
  }
  const sorted = yield* sortJournalSteps(items, compareAgentJournalItems)
  let stable = sorted
  if (prior?.items.length === sorted.length) {
    let same = true
    for (let index = 0; index < sorted.length; index++) {
      same &&= sorted[index] === prior.items[index]
      yield
    }
    if (same) {
      stable = prior.items
    }
  }
  if (!current || current()) {
    promptProjections.set(journal, {
      ...cursor,
      fence: work.liveFence,
      items: stable,
      dependencies
    })
  }
  return stable
}
