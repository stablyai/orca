import {
  finishJournalSteps,
  finishJournalStepsAsync
} from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { JournalReadSince } from '../agent-session-journal/journal-store-contracts'
import { projectJournalBatchSteps } from './agent-session-journal-batch'
import { buildPageSteps } from './agent-session-history-page-fields'
import {
  historyContentBytes,
  measureHistoryItem,
  oversizedHistoryItem,
  submissionBytesByItemIdSteps,
  type HistoryReader
} from './agent-session-history-page-bounds'

export function readForward(
  ...args: Parameters<typeof readForwardSteps>
): AgentSessionHistoryResult | Promise<AgentSessionHistoryResult> {
  return finishJournalSteps(readForwardSteps(...args))
}

export async function readForwardFinite(
  ...args: Parameters<typeof readForwardSteps>
): Promise<AgentSessionHistoryResult> {
  return await finishJournalStepsAsync(readForwardSteps(...args))
}

function* readForwardSteps(
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor,
  limit: number,
  reader: HistoryReader,
  since: JournalReadSince,
  canonicalItemId: (id: string) => string,
  queueSourceIds: (id: string) => readonly string[],
  reset: (
    reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ) => Promise<AgentSessionHistoryResult>
): Generator<void, AgentSessionHistoryResult | Promise<AgentSessionHistoryResult>> {
  if (!since.ok) {
    return reset(since.reset)
  }
  let submissionBytes = yield* submissionBytesByItemIdSteps(snapshot.submissions)
  const submissionIds = new Set<string>()
  for (const entry of snapshot.submissions) {
    submissionIds.add(entry.clientMessageId)
    yield
  }
  // Shrink the row window; clipping items after advancing the cursor would permanently lose revisions.
  let rows = since.rows.slice(0, limit)
  const project = function* (window: typeof rows) {
    const result = yield* projectJournalBatchSteps({
      rows: window,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId,
      queueSourceIds,
      hasSubmission: (id) => submissionIds.has(id)
    })
    if (!result.ok) {
      return result
    }
    submissionBytes = yield* submissionBytesByItemIdSteps(result.batch.submissions)
    return { ...result, batch: { ...result.batch, items: result.batch.items.map(reader.form) } }
  }
  let projected = yield* project(rows)
  if (!projected.ok) {
    return reset(projected.reset)
  }
  let contentBytes = historyContentBytes(
    projected.batch.items,
    projected.batch.removedItemIds,
    submissionBytes
  )
  while (rows.length > 1 && contentBytes > reader.budgetBytes) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = yield* project(rows)
    if (!shrunk.ok) {
      return reset(shrunk.reset)
    }
    projected = shrunk
    contentBytes = historyContentBytes(
      projected.batch.items,
      projected.batch.removedItemIds,
      submissionBytes
    )
  }
  let items = projected.batch.items
  if (contentBytes > reader.budgetBytes) {
    items = items.map((formed) => {
      const bytes = formed.bytes + (submissionBytes.get(formed.item.itemId) ?? 0)
      return bytes > reader.budgetBytes
        ? measureHistoryItem(oversizedHistoryItem(formed.item))
        : formed
    })
    contentBytes = historyContentBytes(items, projected.batch.removedItemIds, submissionBytes)
  }
  if (contentBytes > reader.budgetBytes) {
    // A single row's semantic payload — in practice a pre-bounding oversized
    // removal id — can never fit any page, and truncating a removal id would
    // break the client's keying. A bounded tail replaces the client's state
    // wholesale, which applies the removal without carrying the id, and the
    // client resumes from the live cursor past this row.
    return reset('cursor_compacted')
  }
  const hasNewer = since.rows.length > rows.length
  // A complete read moves past trailing writes that saved nothing. `through` cannot run ahead of
  // `snapshot`: each write commits and adopts its state in one synchronous step on the write lane.
  const lastSequence = hasNewer ? (rows.at(-1)?.seq ?? cursor.sequence) : since.through
  return {
    ok: true,
    page: yield* buildPageSteps({
      snapshot,
      submissions: projected.batch.submissions,
      direction: 'after',
      items: items.map(({ item }) => item),
      removedItemIds: projected.batch.removedItemIds,
      hasOlder: cursor.sequence > 0,
      hasNewer,
      fallbackCursor: cursor,
      nextCursor: { epoch: cursor.epoch, sequence: lastSequence }
    })
  }
}
