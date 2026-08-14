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
    return { ok: false, reset: 'schema_unreadable', snapshot }
  }
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction === 'after') {
    return readForward(journal, snapshot, request.cursor, limit)
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return { ok: false, reset: 'epoch_changed', snapshot }
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return { ok: false, reset: 'cursor_ahead', snapshot }
    }
  }
  const older = cursor
    ? snapshot.items.filter((item) => item.sequence < cursor.sequence)
    : snapshot.items
  const items = older.slice(Math.max(0, older.length - limit))
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: request.direction,
      items,
      hasOlder: older.length > items.length,
      hasNewer: older.length < snapshot.items.length,
      fallbackCursor: cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      nextCursor: items[0]
        ? { epoch: snapshot.cursor.epoch, sequence: items[0].sequence }
        : undefined
    })
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
    return { ok: false, reset: 'cursor_ahead', snapshot }
  }
  const since = journal.readSince(cursor)
  if (!since.ok) {
    return { ok: false, reset: since.reset, snapshot }
  }
  const rows = since.rows.slice(0, limit)
  const projected = projectJournalBatch({ rows, snapshot, afterSequence: cursor.sequence })
  if (!projected.ok) {
    return { ok: false, reset: projected.reset, snapshot }
  }
  const lastSequence = rows.at(-1)?.seq ?? cursor.sequence
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: 'after',
      items: projected.batch.items,
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
}): AgentSessionHistoryPage {
  const epoch = input.snapshot.cursor.epoch
  const pageItemIds = new Set(input.items.map((item) => item.itemId))
  const oldest = input.items[0]
  const newest = input.items.at(-1)
  return {
    sessionId: input.snapshot.sessionId,
    epoch,
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
