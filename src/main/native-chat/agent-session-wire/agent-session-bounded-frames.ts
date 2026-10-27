// Fit phone bridge limits by splitting queue/roster lists into side batches.
// Omit slash commands because phones read them through agentSession.options.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import { boundedQueuePublication } from './agent-session-bounded-queue'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  type HistoryReader
} from './agent-session-history-page-bounds'
import { agentJournalItemForWire, CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

const BOUNDED_FRAME_READER: HistoryReader = {
  form: (item) => boundedFrameItem(agentJournalItemForWire(item)),
  budgetBytes: BOUNDED_FRAME_CONTENT_BUDGET_BYTES
}

export function subscriberHistoryReader(subscriber: { boundedFrames: boolean }): HistoryReader {
  return subscriber.boundedFrames ? BOUNDED_FRAME_READER : CLIENT_HISTORY_READER
}

/** Omit oversized metadata rather than exceeding the envelope; readers treat absence as unspecified. */
const BOUNDED_FRAME_LATEST_TURN_BYTES = 8 * 1024
const BOUNDED_FRAME_ACTIVITY_BYTES = 2 * 1024

type HistoryFrame = Exclude<AgentSessionSubscribeEvent, { type: 'end' }>
type BatchFrame = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type SideFields = Pick<
  BatchFrame,
  'queuedMessages' | 'queuePause' | 'nextQueuedMessageId' | 'backgroundTasks'
>

function within(value: unknown, maxBytes: number): boolean {
  return value === null || jsonBytes(value) <= maxBytes
}

/** Side frames must name the cursor after history is applied. */
function cursorAfter(event: HistoryFrame): AgentJournalCursor {
  return event.type === 'batch'
    ? event.batch.cursor
    : (event.page.liveCursor ?? event.page.window.nextCursor)
}

/** Remove side lists and oversized metadata before attaching separately budgeted fields. */
function boundedHistoryFrame(event: HistoryFrame): HistoryFrame {
  const { backgroundTasks: _backgroundTasks, activity, ...rest } = event
  const frame = {
    ...rest,
    ...(activity !== undefined && within(activity, BOUNDED_FRAME_ACTIVITY_BYTES)
      ? { activity }
      : {})
  }
  if (frame.type === 'batch') {
    const { actionablePromptIds, ...batchFields } = frame
    const bounded =
      actionablePromptIds === undefined ||
      within(actionablePromptIds, BOUNDED_FRAME_LATEST_TURN_BYTES)
        ? frame
        : batchFields
    const { latestTurn, ...batch } = bounded
    return latestTurn === undefined || within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES)
      ? bounded
      : batch
  }
  const { actionablePromptIds, ...pageFields } = frame.page
  const boundedPage =
    actionablePromptIds === undefined ||
    within(actionablePromptIds, BOUNDED_FRAME_LATEST_TURN_BYTES)
      ? frame.page
      : pageFields
  const { latestTurn, ...page } = boundedPage
  return latestTurn === undefined || within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES)
    ? { ...frame, page: boundedPage }
    : { ...frame, page }
}

function isEmptyBatch(frame: HistoryFrame): frame is BatchFrame {
  return (
    frame.type === 'batch' &&
    frame.batch.items.length === 0 &&
    frame.batch.removedItemIds.length === 0 &&
    frame.batch.submissions.length === 0
  )
}

/** Discard older rows from the least informative lists first; incomplete signals omissions. */
function withoutOlderRows(state: AgentSessionBackgroundTaskState): AgentSessionBackgroundTaskState {
  let fitted = state
  for (const list of ['settledTasks', 'children', 'tasks'] as const) {
    while (
      (fitted[list]?.length ?? 0) > 0 &&
      jsonBytes(fitted) > BOUNDED_FRAME_CONTENT_BUDGET_BYTES
    ) {
      const rows = fitted[list] ?? []
      fitted = { ...fitted, [list]: rows.slice(Math.ceil(rows.length / 2)), incomplete: true }
    }
  }
  return fitted
}

function boundedBackgroundTasks(
  state: AgentSessionBackgroundTaskState | null
): AgentSessionBackgroundTaskState | null {
  if (state === null) {
    return null
  }
  return (
    shortenJsonStringsToFit(state, BOUNDED_FRAME_CONTENT_BUDGET_BYTES) ??
    shortenJsonStringsToFit(withoutOlderRows(state), BOUNDED_FRAME_CONTENT_BUDGET_BYTES) ?? {
      state: state.state,
      incomplete: true
    }
  )
}

type BoundedSideLists = {
  queued: QueuePublication | undefined
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined
}

/** Send history first, then side lists; reuse empty history batches for the first list. */
export function boundedFrames(
  event: AgentSessionSubscribeEvent,
  side: BoundedSideLists
): AgentSessionSubscribeEvent[] {
  if (event.type === 'end') {
    return [event]
  }
  const lists: SideFields[] = [
    ...(side.queued === undefined ? [] : [boundedQueuePublication(side.queued)]),
    ...(side.backgroundTasks === undefined
      ? []
      : [{ backgroundTasks: boundedBackgroundTasks(side.backgroundTasks) }])
  ]
  const history = boundedHistoryFrame(event)
  const carrier = (fields: SideFields): BatchFrame => ({
    type: 'batch',
    sessionId: event.sessionId,
    batch: emptyAgentSessionBatch(cursorAfter(event)),
    ...(event.fence === undefined ? {} : { fence: event.fence }),
    ...(event.hostNow === undefined ? {} : { hostNow: event.hostNow }),
    ...fields
  })
  if (lists.length > 0 && isEmptyBatch(history)) {
    const [first, ...others] = lists
    return [{ ...history, ...first }, ...others.map(carrier)]
  }
  return [history, ...lists.map(carrier)]
}
