import { readAgentSessionForwardHistory } from './agent-session-history-forward-page'
import { buildAgentSessionHistoryPage } from './agent-session-history-page-result'
import { resolveHistoryLimit } from './agent-session-history-limit'
import { isRootAgentJournalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-producer'

import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import {
  boundHistoryItemsByBytes,
  isSubagentRow,
  type HistoryReader,
  newestWholeSequenceGroups,
  wholeSubagentGroupsStart,
  submissionBytesByItemId
} from './agent-session-history-page-bounds'
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'

// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../../../../shared/agent-session/agent-session-wire'

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

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    view = journal.publicRead(),
    snapshot,
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
    const readSnapshot = snapshot ? () => snapshot! : view.snapshotForItems
    snapshot ??= readSnapshot(new Set())
    if (
      !rowReplay &&
      request.cursor?.epoch === snapshot.cursor.epoch &&
      request.cursor.sequence <= snapshot.cursor.sequence &&
      view.normalizationKey !== ''
    ) {
      return historyReset(journal, 'cursor_compacted', reader)
    }
    return readAgentSessionForwardHistory(
      {
        readSince: (cursor, count) => journal.readSince(cursor, count),
        canonicalItemId: (itemId) => journal.canonicalItemId(itemId),
        hasSubmission: (id) => journal.submission(id) !== undefined,
        queueSourceIds: reader.queueSourceIds?.bind(undefined, journal),
        reset: (reset) => historyReset(journal, reset, reader)
      },
      snapshot,
      request.cursor,
      limit,
      reader,
      (ids) => {
        const selected = readSnapshot(ids)
        return reader.snapshot?.(journal, selected, ids) ?? selected
      }
    )
  }
  snapshot ??= view.currentSnapshot()
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return historyReset(journal, 'epoch_changed', reader)
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return historyReset(journal, 'cursor_ahead', reader)
    }
  }
  snapshot = reader.snapshot?.(journal, snapshot) ?? snapshot
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
    page: buildAgentSessionHistoryPage({
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
  initialView = journal.publicRead()
): (request: AgentSessionHistoryRequest) => AgentSessionHistoryResult {
  let view = initialView
  return (request) => {
    const live = journal.publicRead()
    if (view !== live) {
      view = live
    }
    return readAgentSessionHistory(journal, request, { view, reader, rowReplay: true })
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
  return buildAgentSessionHistoryPage({
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
  journal: AgentSessionJournal,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset'],
  reader: HistoryReader
): AgentSessionHistoryResult {
  return {
    ok: false,
    reset,
    page: readAgentSessionHydrationPage(journal, undefined, reader)
  }
}
