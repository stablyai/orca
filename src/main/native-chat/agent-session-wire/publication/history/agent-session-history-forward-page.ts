import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReadSince } from '../../../agent-session-journal/journal-store-contracts'
import { projectJournalBatch } from './agent-session-journal-batch'
import { buildAgentSessionHistoryPage } from './agent-session-history-page-result'
import {
  historyContentBytes,
  type HistoryReader,
  measureHistoryItem,
  oversizedHistoryItem,
  submissionBytesByItemId
} from './agent-session-history-page-bounds'

export type JournalForwardHistorySource = {
  readSince: (cursor: AgentJournalCursor, limit?: number) => JournalReadSince
  canonicalItemId: (itemId: string) => string
  hasSubmission: (id: string) => boolean
  queueSourceIds?: (messageId: string) => readonly string[]
  stopNoteIds?: (turnItemIds: ReadonlySet<string>) => readonly string[]
  reset: (
    reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ) => AgentSessionHistoryResult
}

/** SQL and in-memory readers use the same replay, shrink and cursor rules. */
export function readAgentSessionForwardHistory(
  source: JournalForwardHistorySource,
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
  readSnapshot: (ids: Set<string>) => AgentJournalSnapshot
): AgentSessionHistoryResult {
  if (!cursor) {
    // Why: forward paging replays rows after a position; without one there is
    // nothing to be after, and silently serving the tail would hand the client
    // a page it cannot place.
    return source.reset('cursor_ahead')
  }
  // One lookahead determines hasNewer without rereading the whole remaining journal.
  const since = source.readSince(cursor, limit + 1)
  if (!since.ok) {
    return source.reset(since.reset)
  }
  let submissionBytes = submissionBytesByItemId(snapshot.submissions)
  // Shrink the row window; clipping items after advancing the cursor would permanently lose revisions.
  let rows = since.rows.slice(0, limit)
  const project = (window: typeof rows) => {
    const result = projectJournalBatch({
      rows: window,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId: source.canonicalItemId,
      hasSubmission: source.hasSubmission,
      queueSourceIds: source.queueSourceIds,
      stopNoteIds: source.stopNoteIds,
      readSnapshot
    })
    if (!result.ok) {
      return result
    }
    submissionBytes = submissionBytesByItemId(result.batch.submissions)
    return { ...result, batch: { ...result.batch, items: result.batch.items.map(reader.form) } }
  }
  let projected = project(rows)
  if (!projected.ok) {
    return source.reset(projected.reset)
  }
  let contentBytes = historyContentBytes(
    projected.batch.items,
    projected.batch.removedItemIds,
    submissionBytes
  )
  while (rows.length > 1 && contentBytes > reader.budgetBytes) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = project(rows)
    if (!shrunk.ok) {
      return source.reset(shrunk.reset)
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
    return source.reset('cursor_compacted')
  }
  const hasNewer = since.rows.length > rows.length
  // A complete read moves past trailing writes that saved nothing. `through` cannot run ahead of
  // `snapshot`: each write commits and adopts its state in one synchronous step on the write lane.
  const lastSequence = hasNewer ? (rows.at(-1)?.seq ?? cursor.sequence) : since.through
  return {
    ok: true,
    page: buildAgentSessionHistoryPage({
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
