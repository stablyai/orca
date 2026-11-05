import {
  buildPage,
  conversationWindow,
  buildHydrationPage,
  historyReset
} from './agent-session-history-page-fields'
import type { JournalReadSince } from '../agent-session-journal/journal-store-contracts'
import { resolveHistoryLimit } from './agent-session-history-limit'

// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'

import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import {
  boundHistoryItemsByBytes,
  historyContentBytes,
  type HistoryReader,
  measureHistoryItem,
  oversizedHistoryItem,
  submissionBytesByItemId
} from './agent-session-history-page-bounds'
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'
export { resolveHistoryLimit } from './agent-session-history-limit'
// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

/** In-process only: both scopes window by own-agent rows; own-agent also excludes other producers. */
export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

export type HistoryReadOptions = {
  /** Reuse a snapshot across synchronous catch-up pages to avoid repeated full reduction. */
  captureResult?: (
    snapshot: AgentJournalSnapshot,
    view: Pick<
      ReturnType<AgentSessionJournal['publicRead']>,
      'snapshot' | 'normalizationKey' | 'currentSnapshot'
    >
  ) => (result: AgentSessionHistoryResult) => AgentSessionHistoryResult
  snapshot?: AgentJournalSnapshot
  view?: Pick<
    ReturnType<AgentSessionJournal['publicRead']>,
    'snapshot' | 'normalizationKey' | 'currentSnapshot'
  >
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
    const base = options.snapshot ?? view.currentSnapshot()
    const snapshot = reader.snapshot?.(journal, base) ?? base
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
    (view) => ({
      apply: decorate(view.snapshot, view),
      queueSources: new Map(
        reader.queueSourceIds
          ? journal.queuedMessages
              .list()
              .map(
                (card) => [card.messageId, reader.queueSourceIds!(journal, card.messageId)] as const
              )
          : []
      )
    }),
    (since, view, canonical, captured) => {
      const snapshot = view.snapshot
      const result =
        !options.rowReplay &&
        cursor.epoch === snapshot.cursor.epoch &&
        cursor.sequence <= snapshot.cursor.sequence &&
        view.normalizationKey !== ''
          ? historyReset(snapshot, 'cursor_compacted', reader)
          : readForward(
              snapshot,
              cursor,
              limit,
              reader,
              since,
              canonical,
              (id) => captured.queueSources.get(id) ?? []
            )
      return structuredClone(captured.apply(result))
    },
    (snapshot) => reader.snapshot?.(journal, snapshot) ?? snapshot
  )
}

function readHistoryMemory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    view = journal.publicRead(),
    snapshot,
    scope = 'every-agent',
    reader = CLIENT_HISTORY_READER
  }: HistoryReadOptions = {}
): AgentSessionHistoryResult {
  const limit = resolveHistoryLimit(request.limit)
  snapshot ??= view.currentSnapshot()
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
  initialView: NonNullable<HistoryReadOptions['view']> = journal.publicRead(),
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
  snapshot: AgentJournalSnapshot = journal.currentRead()
): AgentSessionHistoryPage {
  return buildHydrationPage(reader.snapshot?.(journal, snapshot) ?? snapshot, fence, reader)
}

function readForward(
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor,
  limit: number,
  reader: HistoryReader,
  since: JournalReadSince,
  canonicalItemId: (id: string) => string,
  queueSourceIds: (id: string) => readonly string[]
): AgentSessionHistoryResult {
  if (!since.ok) {
    return historyReset(snapshot, since.reset, reader)
  }
  let submissionBytes = submissionBytesByItemId(snapshot.submissions)
  // Shrink the row window; clipping items after advancing the cursor would permanently lose revisions.
  let rows = since.rows.slice(0, limit)
  const project = (window: typeof rows) => {
    const result = projectJournalBatch({
      rows: window,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId,
      queueSourceIds,
      hasSubmission: (id) => snapshot.submissions.some((entry) => entry.clientMessageId === id)
    })
    if (!result.ok) {
      return result
    }
    submissionBytes = submissionBytesByItemId(result.batch.submissions)
    return { ...result, batch: { ...result.batch, items: result.batch.items.map(reader.form) } }
  }
  let projected = project(rows)
  if (!projected.ok) {
    return historyReset(snapshot, projected.reset, reader)
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
      return historyReset(snapshot, shrunk.reset, reader)
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
