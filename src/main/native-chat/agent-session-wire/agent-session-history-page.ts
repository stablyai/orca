import { resolveHistoryLimit } from './agent-session-history-limit'
export { resolveHistoryLimit } from './agent-session-history-limit'
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
import { snapshotLatestTurn } from './agent-session-history-latest-turn'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryDirection,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult,
  type AgentSessionSubagentRosterEntry
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import {
  boundHistoryItemsByBytes,
  type HistoryReader,
  measureHistoryItem,
  newestWholeSequenceGroups,
  wholeSubagentGroupsStart,
  oversizedHistoryItem,
  submissionBytesByItemId
} from './agent-session-history-page-bounds'
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

/** Whose rows a backward read serves. Both window over the session's own rows; a
 *  reader of the session's own agent alone gets only those. In-process only: no wire
 *  request carries it. */
export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

/** Window by own-agent rows, retaining contiguous subagent work and whole sibling groups within byte bounds. */
function conversationWindow(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const own = items.filter((item) => isRootAgentJournalItem(item) && !isSubagentRow(item))
  if (own.length === items.length) {
    return newestWholeSequenceGroups(items, limit)
  }
  const ownWindow = newestWholeSequenceGroups(own, limit)
  const start = ownWindow.length < own.length ? ownWindow[0]?.sequence : undefined
  if (start === undefined) {
    return [...items]
  }
  const reach = newestWholeSequenceGroups(own, 2 * limit)
  const floor = reach.length < own.length ? reach[0]!.sequence : Number.NEGATIVE_INFINITY
  const whole = wholeSubagentGroupsStart(items, start, floor)
  return items.filter((item) => item.sequence >= whole)
}

function isSubagentRow(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'message' && item.body.blocks.some(isSubagentBlock)
}

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    view = journal.publicRead(),
    snapshot = view.snapshot,
    scope = 'every-agent',
    reader = CLIENT_HISTORY_READER,
    rowReplay = false
  }: {
    /** Reuse a snapshot across synchronous catch-up pages to avoid repeated full reduction. */
    snapshot?: AgentJournalSnapshot
    view?: ReturnType<AgentSessionJournal['publicRead']>
    scope?: AgentSessionHistoryScope
    reader?: HistoryReader
    /** Internal catch-up and older item-backed clients keep their existing row replay. */
    rowReplay?: boolean
  } = {}
): AgentSessionHistoryResult {
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction === 'after') {
    if (
      !rowReplay &&
      request.cursor?.epoch === snapshot.cursor.epoch &&
      request.cursor.sequence <= snapshot.cursor.sequence &&
      view.normalizationKey !== ''
    ) {
      return historyReset(snapshot, 'cursor_compacted', reader)
    }
    return readForward(journal, snapshot, request.cursor, limit, reader)
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return historyReset(snapshot, 'epoch_changed', reader)
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return historyReset(snapshot, 'cursor_ahead', reader)
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
    reader.budgetBytes,
    reader.form
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

/** Reuse reduced state until the journal cursor advances. */
export function createAgentSessionCatchUpReader(
  journal: AgentSessionJournal,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  initialView = journal.publicRead()
): (request: AgentSessionHistoryRequest) => AgentSessionHistoryResult {
  let view = initialView
  return (request) => {
    const live = journal.cursor()
    const prior = view.snapshot.cursor
    if (live.epoch !== prior.epoch || live.sequence !== prior.sequence) {
      view = journal.publicRead()
    }
    return readAgentSessionHistory(journal, request, { view, reader, rowReplay: true })
  }
}

export function readAgentSessionHydrationPage(
  journal: AgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  snapshot: AgentJournalSnapshot = journal.snapshot()
): AgentSessionHistoryPage {
  return buildHydrationPage(snapshot, fence, reader)
}

function buildHydrationPage(
  snapshot: AgentJournalSnapshot,
  fence: number | undefined,
  reader: HistoryReader
): AgentSessionHistoryPage {
  const items = conversationWindow(snapshot.items, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const bounded = boundHistoryItemsByBytes(
    items,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    reader.budgetBytes,
    reader.form
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
  reader: HistoryReader
): AgentSessionHistoryResult {
  return {
    ok: false,
    reset,
    page: buildHydrationPage(snapshot, undefined, reader)
  }
}

function readForward(
  journal: AgentSessionJournal,
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  reader: HistoryReader
): AgentSessionHistoryResult {
  if (!cursor) {
    // Forward paging without a cursor cannot place its rows; force reset.
    return historyReset(snapshot, 'cursor_ahead', reader)
  }
  // One lookahead determines hasNewer without rereading the whole remaining journal.
  const since = journal.readSince(cursor, limit + 1)
  if (!since.ok) {
    return historyReset(snapshot, since.reset, reader)
  }
  const submissionBytes = submissionBytesByItemId(snapshot.submissions)
  // Count submissions and removal IDs too: legacy tombstones can outweigh all item content.
  const pageContentBytes = (
    items: readonly ReturnType<HistoryReader['form']>[],
    removedItemIds: readonly string[]
  ): number =>
    items.reduce(
      (total, { item, bytes }) => total + bytes + (submissionBytes.get(item.itemId) ?? 0),
      0
    ) +
    removedItemIds.reduce(
      (total, itemId) => total + Buffer.byteLength(JSON.stringify(itemId), 'utf8') + 1,
      0
    )
  // Shrink the row window; clipping items after advancing the cursor would permanently lose revisions.
  let rows = since.rows.slice(0, limit)
  const project = (window: typeof rows) => {
    const result = projectJournalBatch({
      rows: window,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId: (itemId) => journal.canonicalItemId(itemId)
    })
    return result.ok
      ? { ...result, batch: { ...result.batch, items: result.batch.items.map(reader.form) } }
      : result
  }
  let projected = project(rows)
  if (!projected.ok) {
    return historyReset(snapshot, projected.reset, reader)
  }
  let contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  while (rows.length > 1 && contentBytes > reader.budgetBytes) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = project(rows)
    if (!shrunk.ok) {
      return historyReset(snapshot, shrunk.reset, reader)
    }
    projected = shrunk
    contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  }
  let items = projected.batch.items
  if (contentBytes > reader.budgetBytes) {
    items = items.map((formed) => {
      const bytes = formed.bytes + (submissionBytes.get(formed.item.itemId) ?? 0)
      return bytes > reader.budgetBytes
        ? measureHistoryItem(oversizedHistoryItem(formed.item))
        : formed
    })
    contentBytes = pageContentBytes(items, projected.batch.removedItemIds)
  }
  if (contentBytes > reader.budgetBytes) {
    // Unsplittable removal IDs require whole-state reset; resume at the live cursor past the oversized row.
    return historyReset(snapshot, 'cursor_compacted', reader)
  }
  const lastSequence = rows.at(-1)?.seq ?? cursor.sequence
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: 'after',
      items: items.map(({ item }) => item),
      removedItemIds: projected.batch.removedItemIds,
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
    ...(input.subagentRoster === undefined ? {} : { subagentRoster: input.subagentRoster }),
    // Read the whole timeline: long turns can begin below this page.
    latestTurn: snapshotLatestTurn(input.snapshot)
  }
}
