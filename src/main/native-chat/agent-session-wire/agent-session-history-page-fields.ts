import type { AgentSessionHistoryRequest } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionHistoryScope } from './agent-session-history-page'
import { resolveHistoryLimit } from './agent-session-history-limit'
import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session/agent-session-wire'
import {
  boundHistoryItemsByBytesSteps,
  isSubagentRow,
  newestWholeSequenceGroupsSteps,
  wholeSubagentGroupsStartSteps,
  submissionBytesByItemIdSteps,
  type HistoryPageInput,
  type HistoryReader
} from './agent-session-history-page-bounds'
import { offPageSubagentRosterSteps } from './agent-session-history-subagent-roster'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session/agent-session-wire'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { snapshotLatestTurnSteps } from './agent-session-history-latest-turn'
export function buildPage(input: HistoryPageInput): AgentSessionHistoryPage {
  return finishJournalSteps(buildPageSteps(input))
}

export function* buildPageSteps(input: HistoryPageInput): Generator<void, AgentSessionHistoryPage> {
  const epoch = input.snapshot.cursor.epoch
  const pageItemIds = new Set<string>()
  for (const item of input.items) {
    pageItemIds.add(item.itemId)
    yield
  }
  const submissions: AgentJournalSnapshot['submissions'] = []
  for (const submission of input.submissions ?? input.snapshot.submissions) {
    if (pageItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))) {
      submissions.push(submission)
    }
    yield
  }
  const oldest = input.items[0]
  const newest = input.items.at(-1)
  return {
    sessionId: input.snapshot.sessionId,
    epoch,
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
    direction: input.direction,
    items: input.items,
    removedItemIds: input.removedItemIds ?? [],
    submissions,
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
    latestTurn: yield* snapshotLatestTurnSteps(input.snapshot)
  }
}

/** Window by own-agent rows, retaining contiguous subagent work and whole sibling groups within byte bounds. */
export function conversationWindow(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  return finishJournalSteps(conversationWindowSteps(items, limit))
}

export function* conversationWindowSteps(
  items: readonly AgentJournalRenderItem[],
  limit: number
): Generator<void, AgentJournalRenderItem[]> {
  const own: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (isRootAgentJournalItem(item) && !isSubagentRow(item)) {
      own.push(item)
    }
    yield
  }
  if (own.length === items.length) {
    return yield* newestWholeSequenceGroupsSteps(items, limit)
  }
  const ownWindow = yield* newestWholeSequenceGroupsSteps(own, limit)
  const start = ownWindow.length < own.length ? ownWindow[0]?.sequence : undefined
  if (start === undefined) {
    const result: AgentJournalRenderItem[] = []
    for (const item of items) {
      result.push(item)
      yield
    }
    return result
  }
  const reach = yield* newestWholeSequenceGroupsSteps(own, 2 * limit)
  const floor = reach.length < own.length ? reach[0]!.sequence : Number.NEGATIVE_INFINITY
  const whole = yield* wholeSubagentGroupsStartSteps(items, start, floor)
  const result: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (item.sequence >= whole) {
      result.push(item)
    }
    yield
  }
  return result
}

export function buildHydrationPage(
  snapshot: AgentJournalSnapshot,
  fence: number | undefined,
  reader: HistoryReader
): AgentSessionHistoryPage {
  return finishJournalSteps(buildHydrationPageSteps(snapshot, fence, reader))
}

export function* buildHydrationPageSteps(
  snapshot: AgentJournalSnapshot,
  fence: number | undefined,
  reader: HistoryReader
): Generator<void, AgentSessionHistoryPage> {
  const items = yield* conversationWindowSteps(snapshot.items, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const bounded = yield* boundHistoryItemsByBytesSteps(
    items,
    'newest',
    yield* submissionBytesByItemIdSteps(snapshot.submissions),
    reader.budgetBytes,
    reader.form
  )
  return yield* buildPageSteps({
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
    subagentRoster: yield* offPageSubagentRosterSteps(snapshot.items, bounded.items)
  })
}

export function historyReset(
  snapshot: AgentJournalSnapshot,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset'],
  reader: HistoryReader
): AgentSessionHistoryResult {
  return finishJournalSteps(historyResetSteps(snapshot, reset, reader))
}

export function* historyResetSteps(
  snapshot: AgentJournalSnapshot,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset'],
  reader: HistoryReader
): Generator<void, AgentSessionHistoryResult> {
  return {
    ok: false,
    reset,
    page: yield* buildHydrationPageSteps(snapshot, undefined, reader)
  }
}

export function* readHistoryMemorySteps(
  request: AgentSessionHistoryRequest,
  snapshot: AgentJournalSnapshot,
  scope: AgentSessionHistoryScope,
  reader: HistoryReader
): Generator<void, AgentSessionHistoryResult> {
  const limit = resolveHistoryLimit(request.limit)
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return yield* historyResetSteps(snapshot, 'epoch_changed', reader)
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return yield* historyResetSteps(snapshot, 'cursor_ahead', reader)
    }
  }
  const scoped: AgentJournalSnapshot['items'] = []
  const older: AgentJournalSnapshot['items'] = []
  for (const item of snapshot.items) {
    if (scope !== 'own-agent' || isRootAgentJournalItem(item)) {
      scoped.push(item)
      if (!cursor || item.sequence < cursor.sequence) {
        older.push(item)
      }
    }
    yield
  }
  const windowed = yield* conversationWindowSteps(older, limit)
  const { items, dropped } = yield* boundHistoryItemsByBytesSteps(
    windowed,
    'newest',
    yield* submissionBytesByItemIdSteps(snapshot.submissions),
    reader.budgetBytes,
    reader.form
  )
  return {
    ok: true,
    page: yield* buildPageSteps({
      snapshot,
      direction: request.direction,
      items,
      hasOlder: older.length > windowed.length || dropped > 0,
      hasNewer: older.length < scoped.length,
      fallbackCursor: cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      nextCursor: items[0]
        ? { epoch: snapshot.cursor.epoch, sequence: items[0].sequence }
        : undefined,
      subagentRoster: yield* offPageSubagentRosterSteps(scoped, items)
    })
  }
}
