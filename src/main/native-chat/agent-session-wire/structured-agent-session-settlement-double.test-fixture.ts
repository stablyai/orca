// Doubles for unit tests that drive a settlement without a journal database: a planned batch is
// planned at once and handed to an `appendLifecycleBatch` mock as the batch it would write.

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionChildExitSession } from './structured-agent-session-child-exit'
import type {
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput
} from '../agent-session-journal/journal-store-contracts'

const NO_CURSOR: AgentJournalCursor = { epoch: 'epoch-1', sequence: 0 }

/** `appendPlannedLifecycleBatch` for a double: a plan with no row reaches no `append`, as the
 *  writer writes none. */
export function plannedBatchThrough(
  append: (input: JournalLifecycleBatchInput) => Promise<AgentJournalCursor>
): (input: JournalPlannedLifecycleBatchInput) => Promise<AgentJournalCursor> {
  return async (input) => {
    const { mutations, dispatches } = input.plan()
    if (mutations.length === 0 && dispatches.length === 0) {
      return NO_CURSOR
    }
    const cursor = await append({
      settlementId: input.settlementId,
      fence: input.fence,
      ...(input.recovered ? { recovered: input.recovered } : {}),
      mutations,
      dispatches
    })
    return cursor
  }
}

/** An exited child's journal for a test without a database: the reads a settlement makes, with a
 *  planned batch handed to `appendLifecycleBatch` (`plannedBatchThrough`). */
export function exitJournalDouble(fields: {
  items: () => readonly AgentJournalRenderItem[]
  appendLifecycleBatch: (input: JournalLifecycleBatchInput) => Promise<AgentJournalCursor>
  itemFence?: (itemId: string) => number | undefined
  submissions?: () => readonly Partial<AgentJournalSubmission>[]
}): StructuredAgentSessionChildExitSession['journal'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a settlement reads only these members; the rest of the journal is unreachable from it.
  return {
    cursor: () => NO_CURSOR,
    itemBody: () => null,
    itemFence: fields.itemFence ?? (() => undefined),
    snapshot: () => ({ items: fields.items() }),
    submissions: fields.submissions ?? (() => []),
    stopMarks: { latest: () => null, personStopDecides: () => false },
    appendPlannedLifecycleBatch: plannedBatchThrough(fields.appendLifecycleBatch)
  } as unknown as StructuredAgentSessionChildExitSession['journal']
}
