// Paged history over one journal.
//
// `tail` and `before` read the REDUCED timeline, so backward paging keeps
// working after compaction — the folded snapshot still holds every live item.
// `after` is the catch-up direction and must read rows instead: an item created
// early and revised late orders by its creation sequence, so an item-window
// read would silently skip that revision. Rows carry the revision, which is why
// `after` is the only direction that can answer `cursor_compacted`.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_DEFAULT_LIMIT,
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryDirection,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'
import {
  boundHistoryItemsByBytes,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  historyEntryBytes,
  newestWholeSequenceGroups,
  oversizedHistoryItem,
  submissionBytesByItemId
} from './agent-session-history-page-bounds'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

/** Clamped, never rejected: a client asking for more than the host will serve
 *  should get a smaller page and keep paging, not an error mid-scroll. */
export function resolveHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest
): AgentSessionHistoryResult {
  const snapshot = journal.snapshot()
  if (journal.isReadOnly) {
    return historyReset(snapshot, 'schema_unreadable')
  }
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction === 'after') {
    return readForward(journal, snapshot, request.cursor, limit)
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return historyReset(snapshot, 'epoch_changed')
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return historyReset(snapshot, 'cursor_ahead')
    }
  }
  const older = cursor
    ? snapshot.items.filter((item) => item.sequence < cursor.sequence)
    : snapshot.items
  const windowed = newestWholeSequenceGroups(older, limit)
  const { items, dropped } = boundHistoryItemsByBytes(
    windowed,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    HISTORY_PAGE_CONTENT_BUDGET_BYTES
  )
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: request.direction,
      items,
      hasOlder: older.length > windowed.length || dropped > 0,
      hasNewer: older.length < snapshot.items.length,
      fallbackCursor: cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      nextCursor: items[0]
        ? { epoch: snapshot.cursor.epoch, sequence: items[0].sequence }
        : undefined
    })
  }
}

export function readAgentSessionHydrationPage(
  journal: AgentSessionJournal,
  fence?: number
): AgentSessionHistoryPage {
  return buildHydrationPage(journal.snapshot(), fence)
}

function buildHydrationPage(
  snapshot: AgentJournalSnapshot,
  fence?: number
): AgentSessionHistoryPage {
  const items = newestWholeSequenceGroups(snapshot.items, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const bounded = boundHistoryItemsByBytes(
    items,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    HISTORY_PAGE_CONTENT_BUDGET_BYTES
  )
  return buildPage({
    snapshot,
    direction: 'tail',
    items: bounded.items,
    hasOlder: snapshot.items.length > items.length || bounded.dropped > 0,
    hasNewer: false,
    fallbackCursor: { epoch: snapshot.cursor.epoch, sequence: 0 },
    nextCursor: bounded.items[0]
      ? { epoch: snapshot.cursor.epoch, sequence: bounded.items[0].sequence }
      : undefined,
    fence
  })
}

function historyReset(
  snapshot: AgentJournalSnapshot,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
): AgentSessionHistoryResult {
  return {
    ok: false,
    reset,
    page: buildHydrationPage(snapshot)
  }
}

function readForward(
  journal: AgentSessionJournal,
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor | undefined,
  limit: number
): AgentSessionHistoryResult {
  if (!cursor) {
    // Why: forward paging replays rows after a position; without one there is
    // nothing to be after, and silently serving the tail would hand the client
    // a page it cannot place.
    return historyReset(snapshot, 'cursor_ahead')
  }
  const since = journal.readSince(cursor)
  if (!since.ok) {
    return historyReset(snapshot, since.reset)
  }
  const submissionBytes = submissionBytesByItemId(snapshot.submissions)
  // The page cost is EVERYTHING variable it carries: items with their
  // submissions AND removal ids — a legal pre-bounding tombstone id can dwarf
  // every item on the page.
  const pageContentBytes = (
    items: readonly AgentJournalRenderItem[],
    removedItemIds: readonly string[]
  ): number =>
    items.reduce((total, item) => total + historyEntryBytes(item, submissionBytes), 0) +
    removedItemIds.reduce(
      (total, itemId) => total + Buffer.byteLength(JSON.stringify(itemId), 'utf8') + 1,
      0
    )
  // Rows replay forward, so the byte bound shrinks the ROW window rather than
  // clipping projected items: dropping an item while advancing the cursor past
  // the rows that touched it would lose that revision for good.
  let rows = since.rows.slice(0, limit)
  let projected = projectJournalBatch({
    rows,
    snapshot,
    afterSequence: cursor.sequence,
    canonicalItemId: (itemId) => journal.canonicalItemId(itemId)
  })
  if (!projected.ok) {
    return historyReset(snapshot, projected.reset)
  }
  while (
    rows.length > 1 &&
    pageContentBytes(projected.batch.items, projected.batch.removedItemIds) >
      HISTORY_PAGE_CONTENT_BUDGET_BYTES
  ) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = projectJournalBatch({
      rows,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId: (itemId) => journal.canonicalItemId(itemId)
    })
    if (!shrunk.ok) {
      return historyReset(snapshot, shrunk.reset)
    }
    projected = shrunk
  }
  // One row can still touch an over-budget item; degrade it visibly.
  const items =
    pageContentBytes(projected.batch.items, projected.batch.removedItemIds) >
    HISTORY_PAGE_CONTENT_BUDGET_BYTES
      ? projected.batch.items.map((item) => {
          const bytes = historyEntryBytes(item, submissionBytes)
          return bytes > HISTORY_PAGE_CONTENT_BUDGET_BYTES
            ? oversizedHistoryItem(item, bytes)
            : item
        })
      : projected.batch.items
  if (pageContentBytes(items, projected.batch.removedItemIds) > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    // A single row's semantic payload — in practice a pre-bounding oversized
    // removal id — can never fit any page, and truncating a removal id would
    // break the client's keying. A bounded tail replaces the client's state
    // wholesale, which applies the removal without carrying the id, and the
    // client resumes from the live cursor past this row.
    return historyReset(snapshot, 'cursor_compacted')
  }
  const lastSequence = rows.at(-1)?.seq ?? cursor.sequence
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: 'after',
      items,
      removedItemIds: projected.batch.removedItemIds,
      // Reading after a position means there is something before it.
      hasOlder: cursor.sequence > 0,
      hasNewer: since.rows.length > rows.length,
      fallbackCursor: cursor,
      nextCursor: { epoch: cursor.epoch, sequence: lastSequence }
    })
  }
}

function buildPage(input: {
  snapshot: AgentJournalSnapshot
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  removedItemIds?: string[]
  hasOlder: boolean
  hasNewer: boolean
  fallbackCursor: AgentJournalCursor
  nextCursor: AgentJournalCursor | undefined
  fence?: number
}): AgentSessionHistoryPage {
  const epoch = input.snapshot.cursor.epoch
  const pageItemIds = new Set(input.items.map((item) => item.itemId))
  const oldest = input.items[0]
  const newest = input.items.at(-1)
  return {
    sessionId: input.snapshot.sessionId,
    epoch,
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
    direction: input.direction,
    items: input.items,
    removedItemIds: input.removedItemIds ?? [],
    submissions: input.snapshot.submissions.filter((submission) =>
      pageItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
    ),
    window: {
      oldest: oldest ? { epoch, sequence: oldest.sequence } : null,
      newest: newest ? { epoch, sequence: newest.sequence } : null,
      nextCursor: input.nextCursor ?? input.fallbackCursor
    },
    liveCursor: input.snapshot.cursor,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer
  }
}
