import { buildPage } from './agent-session-history-page-fields'
import type { JournalReadSince } from '../agent-session-journal/journal-store-contracts'
import { resolveHistoryLimit } from './agent-session-history-limit'
export { resolveHistoryLimit } from './agent-session-history-limit'
// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'

import { isSubagentBlock } from '../../../shared/native-chat/native-chat-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
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

/** In-process only: both scopes window by own-agent rows; own-agent also excludes other producers. */
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

export type HistoryReadOptions = {
  /** Reuse a snapshot across synchronous catch-up pages to avoid repeated full reduction. */
  captureResult?: (
    snapshot: AgentJournalSnapshot,
    view: ReturnType<AgentSessionJournal['publicRead']>
  ) => (result: AgentSessionHistoryResult) => AgentSessionHistoryResult
  snapshot?: AgentJournalSnapshot
  view?: ReturnType<AgentSessionJournal['publicRead']>
  scope?: AgentSessionHistoryScope
  reader?: HistoryReader
  /** Internal catch-up and older item-backed clients keep their existing row replay. */
  rowReplay?: boolean
}

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  options: HistoryReadOptions = {}
): AgentSessionHistoryResult | Promise<AgentSessionHistoryResult> {
  const reader = options.reader ?? CLIENT_HISTORY_READER
  const decorate = options.captureResult ?? (() => (result: AgentSessionHistoryResult) => result)
  if (request.direction !== 'after' || !request.cursor) {
    const view = options.view ?? journal.publicRead()
    const snapshot = options.snapshot ?? view.snapshot
    const result =
      request.direction === 'after'
        ? historyReset(snapshot, 'cursor_ahead', reader)
        : readHistoryMemory(journal, request, { ...options, view, snapshot })
    return decorate(snapshot, view)(result)
  }
  const cursor = request.cursor
  const limit = resolveHistoryLimit(request.limit)
  return journal.readSinceView(
    cursor,
    limit + 1,
    (view) => decorate(view.snapshot, view),
    (since, view, canonical, apply) => {
      const snapshot = view.snapshot
      const result =
        !options.rowReplay &&
        cursor.epoch === snapshot.cursor.epoch &&
        cursor.sequence <= snapshot.cursor.sequence &&
        view.normalizationKey !== ''
          ? historyReset(snapshot, 'cursor_compacted', reader)
          : readForward(snapshot, cursor, limit, reader, since, canonical)
      return structuredClone(apply(result))
    }
  )
}

function readHistoryMemory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    view = journal.publicRead(),
    snapshot = view.snapshot,
    scope = 'every-agent',
    reader = CLIENT_HISTORY_READER
  }: HistoryReadOptions = {}
): AgentSessionHistoryResult {
  const limit = resolveHistoryLimit(request.limit)
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

/** Reuse reduced state until the complete journal source changes. */
export function createAgentSessionCatchUpReader(
  journal: AgentSessionJournal,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  initialView = journal.publicRead(),
  captureResult?: HistoryReadOptions['captureResult']
): (request: AgentSessionHistoryRequest) => Promise<AgentSessionHistoryResult> {
  let view = initialView
  return async (request) => {
    const live = journal.publicRead()
    if (view !== live) {
      view = live
    }
    return readAgentSessionHistory(journal, request, {
      view,
      reader,
      rowReplay: true,
      captureResult
    })
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
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor,
  limit: number,
  reader: HistoryReader,
  since: JournalReadSince,
  canonicalItemId: (id: string) => string
): AgentSessionHistoryResult {
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
      canonicalItemId
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
  const hasNewer = since.rows.length > rows.length
  // A complete read moves past trailing writes that saved nothing. `through` cannot run ahead of
  // `snapshot`: each write commits and adopts its state in one synchronous step on the write lane.
  const lastSequence = hasNewer ? (rows.at(-1)?.seq ?? cursor.sequence) : since.through
  return {
    ok: true,
    page: buildPage({
      snapshot,
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
