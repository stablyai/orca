// Paged history over one journal.
//
// `tail` and `before` read the REDUCED timeline, so backward paging keeps
// working after compaction — the folded snapshot still holds every live item.
// `after` is the catch-up direction and must read rows instead: an item created
// early and revised late orders by its creation sequence, so an item-window
// read would silently skip that revision. Rows carry the revision, which is why
// `after` is the only direction that can answer `cursor_compacted`.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
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
  type AgentSessionHistoryResult,
  type AgentSessionSubagentRosterEntry
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
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

/** Clamped, never rejected: a client asking for more than the host will serve
 *  should get a smaller page and keep paging, not an error mid-scroll. */
export function resolveHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Whose rows a backward read serves. Both window over the session's own rows; a
 *  reader of the session's own agent alone gets only those. In-process only: no wire
 *  request carries it. */
export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

/**
 * The newest `limit` of the session's own rows, in whole sequence groups, and every
 * row after the oldest of them: a subagent's rows ride along with the conversation
 * they happened in, so its burst cannot crowd the conversation off the page. The page
 * stays contiguous and starts at its first item, as the cursor means. Fewer own rows
 * than `limit` reach back to the start. With no subagent rows this is the newest
 * `limit` rows, as before.
 */
function conversationWindow(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const own = items.filter(isRootAgentJournalItem)
  if (own.length === items.length) {
    return newestWholeSequenceGroups(items, limit)
  }
  const ownWindow = newestWholeSequenceGroups(own, limit)
  const start = ownWindow.length < own.length ? ownWindow[0]?.sequence : undefined
  return start === undefined ? [...items] : items.filter((item) => item.sequence >= start)
}

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  /** Reduced state to read against. A synchronous multi-page catch-up passes one
   *  snapshot for the whole run so each page costs its own rows, not the timeline. */
  snapshot: AgentJournalSnapshot = journal.snapshot(),
  scope: AgentSessionHistoryScope = 'every-agent',
  /** Bytes a side field the frame carries takes, held back from its history. */
  reservedBytes = 0
): AgentSessionHistoryResult {
  const budget = HISTORY_PAGE_CONTENT_BUDGET_BYTES - reservedBytes
  if (journal.isReadOnly) {
    return historyReset(snapshot, 'schema_unreadable', budget)
  }
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction === 'after') {
    return readForward(journal, snapshot, request.cursor, limit, budget)
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return historyReset(snapshot, 'epoch_changed', budget)
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return historyReset(snapshot, 'cursor_ahead', budget)
    }
  }
  const scoped =
    scope === 'own-agent' ? snapshot.items.filter(isRootAgentJournalItem) : snapshot.items
  const older = cursor ? scoped.filter((item) => item.sequence < cursor.sequence) : scoped
  const windowed = conversationWindow(older, limit)
  const { items, dropped } = boundHistoryItemsByBytes(
    windowed,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    budget
  )
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: request.direction,
      items,
      hasOlder: older.length > windowed.length || dropped > 0,
      hasNewer: older.length < scoped.length,
      fallbackCursor: cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      nextCursor: items[0]
        ? { epoch: snapshot.cursor.epoch, sequence: items[0].sequence }
        : undefined,
      subagentRoster: offPageSubagentRoster(scoped, items)
    })
  }
}

/**
 * A catch-up run over one journal. Pages share one reduced timeline, so the run
 * costs its own rows instead of re-reducing every item per page; the cursor
 * check re-reduces if anything did advance the journal between pages.
 */
export function createAgentSessionCatchUpReader(
  journal: AgentSessionJournal,
  reservedBytes = 0
): (request: AgentSessionHistoryRequest) => AgentSessionHistoryResult {
  let snapshot = journal.snapshot()
  return (request) => {
    const live = journal.cursor()
    if (live.epoch !== snapshot.cursor.epoch || live.sequence !== snapshot.cursor.sequence) {
      snapshot = journal.snapshot()
    }
    return readAgentSessionHistory(journal, request, snapshot, 'every-agent', reservedBytes)
  }
}

export function readAgentSessionHydrationPage(
  journal: AgentSessionJournal,
  fence?: number,
  reservedBytes = 0
): AgentSessionHistoryPage {
  return buildHydrationPage(
    journal.snapshot(),
    HISTORY_PAGE_CONTENT_BUDGET_BYTES - reservedBytes,
    fence
  )
}

function buildHydrationPage(
  snapshot: AgentJournalSnapshot,
  budget: number,
  fence?: number
): AgentSessionHistoryPage {
  const items = conversationWindow(snapshot.items, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const bounded = boundHistoryItemsByBytes(
    items,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    budget
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
    fence,
    subagentRoster: offPageSubagentRoster(snapshot.items, bounded.items)
  })
}

function historyReset(
  snapshot: AgentJournalSnapshot,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset'],
  budget: number
): AgentSessionHistoryResult {
  return {
    ok: false,
    reset,
    page: buildHydrationPage(snapshot, budget)
  }
}

function readForward(
  journal: AgentSessionJournal,
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  budget: number
): AgentSessionHistoryResult {
  if (!cursor) {
    // Why: forward paging replays rows after a position; without one there is
    // nothing to be after, and silently serving the tail would hand the client
    // a page it cannot place.
    return historyReset(snapshot, 'cursor_ahead', budget)
  }
  // One lookahead preserves hasNewer without rereading the entire remaining journal per page.
  const since = journal.readSince(cursor, limit + 1)
  if (!since.ok) {
    return historyReset(snapshot, since.reset, budget)
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
    return historyReset(snapshot, projected.reset, budget)
  }
  let contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  while (rows.length > 1 && contentBytes > budget) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = projectJournalBatch({
      rows,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId: (itemId) => journal.canonicalItemId(itemId)
    })
    if (!shrunk.ok) {
      return historyReset(snapshot, shrunk.reset, budget)
    }
    projected = shrunk
    contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  }
  // One row can still touch an over-budget item; degrade it visibly.
  let items = projected.batch.items
  if (contentBytes > budget) {
    items = items.map((item) => {
      const bytes = historyEntryBytes(item, submissionBytes)
      return bytes > budget ? oversizedHistoryItem(item) : item
    })
    contentBytes = pageContentBytes(items, projected.batch.removedItemIds)
  }
  if (contentBytes > budget) {
    // A single row's semantic payload — in practice a pre-bounding oversized
    // removal id — can never fit any page, and truncating a removal id would
    // break the client's keying. A bounded tail replaces the client's state
    // wholesale, which applies the removal without carrying the id, and the
    // client resumes from the live cursor past this row.
    return historyReset(snapshot, 'cursor_compacted', budget)
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
  subagentRoster?: AgentSessionSubagentRosterEntry[]
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
    hasNewer: input.hasNewer,
    ...(input.subagentRoster === undefined ? {} : { subagentRoster: input.subagentRoster })
  }
}
