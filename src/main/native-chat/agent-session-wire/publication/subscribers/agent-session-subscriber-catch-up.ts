import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionSlashCommand,
  type AgentSessionSubscribeEvent,
  type AgentSessionTurnActivity
} from '../../../../../shared/agent-session/agent-session-wire'
import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import {
  withPublishedWork,
  withPublishedWorkResult,
  type AgentSessionPublishedWork
} from '../../observations/agent-session-published-work'
import { refreshPublishedWork } from './agent-session-work-refresh'
import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHydrationFrame
} from '../history/agent-session-history-page'
import {
  captureSubscriberFrame,
  readCaughtUpWork,
  SubscriberFrameSuperseded,
  type SubscriberFrameCapture
} from './agent-session-subscriber-frame-capture'
import type { StructuredAgentSessionWorkFrameReader } from '../../observations/structured-agent-session-status-reader'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import {
  subscriberCommandsChanged,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import type { Subscriber } from './agent-session-subscribe-input'

export type SubscriberDeliveryPort = {
  hooks: SubscriberFieldHooks & {
    readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
    readCurrentWork?: (
      sessionId: string,
      journal: AgentSessionJournal
    ) => Promise<StructuredAgentSessionObservedWork | null>
    readWorkFrame?: StructuredAgentSessionWorkFrameReader
    /** In-lane queue for a captured frame; never admits the lane itself. */
    captureQueuePublication?: (
      sessionId: string,
      work: StructuredAgentSessionObservedWork | undefined
    ) => Promise<QueuePublication | null | undefined>
  }
  emit: (
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: {
      withholdQueued?: boolean
      journal?: AgentSessionJournal
      currentWork?: AgentSessionPublishedWork
      historyView?: string
      queuePublication?: { value: QueuePublication | undefined }
    }
  ) => Promise<void>
  isActive: (subscriber: Subscriber) => boolean
  activity: (sessionId: string) => AgentSessionTurnActivity | null
}

type DeliveryInput = {
  subscriber: Subscriber
  journal: AgentSessionJournal
  hostNow: number
  emitCheckpoint: boolean
  activity?: AgentSessionTurnActivity | null | undefined
}

/** The frame last delivered at the subscriber's cursor; undefined when the delivery was abandoned. */
export function deliverToSubscriber(
  port: SubscriberDeliveryPort,
  input: DeliveryInput
): Promise<SubscriberFrameCapture<unknown> | undefined> {
  return unlessSuperseded(deliver(port, input))
}

/** The superseded emission sent nothing; frames before it stand, and an emitted replacement already dropped the work credit, so the next delivery restates. */
async function unlessSuperseded<T>(delivery: Promise<T>): Promise<T | undefined> {
  try {
    return await delivery
  } catch (error) {
    if (error instanceof SubscriberFrameSuperseded) {
      return undefined
    }
    throw error
  }
}

async function deliver(
  port: SubscriberDeliveryPort,
  input: DeliveryInput
): Promise<SubscriberFrameCapture<unknown> | undefined> {
  const { subscriber, journal, hostNow, emitCheckpoint, activity } = input
  const checkpointActivity = emitCheckpoint ? port.activity(subscriber.sessionId) : undefined
  const publishedActivity = activity !== undefined ? activity : checkpointActivity
  const shared = {
    hostNow,
    ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
  }
  const reader = subscriberHistoryReader(subscriber)
  const readPage = createAgentSessionCatchUpReader(journal, reader)
  while (true) {
    const frame = await captureSubscriberFrame(port, subscriber, journal, (work) =>
      // Caught up at the adopted position, so there are no rows to read.
      sameJournalCursor(subscriber.cursor, journal.cursor())
        ? readCaughtUpWork(journal, work)
        : readPage(
            {
              sessionId: subscriber.sessionId,
              direction: 'after',
              cursor: subscriber.cursor,
              limit: AGENT_SESSION_HISTORY_MAX_LIMIT
            },
            work
          )
    )
    if (!frame) {
      return undefined
    }
    const { work } = frame
    const delivery = capturedPort(port, journal, frame)
    if (frame.value === undefined) {
      await emitCaughtUp(port, subscriber, journal, emitCheckpoint, shared, frame)
      return frame
    }
    const result = withPublishedWorkResult(frame.value, work)
    if (!result.ok) {
      const page = { ...result.page, fence: subscriber.fence }
      await delivery.emit(subscriber, {
        type: 'reset',
        sessionId: subscriber.sessionId,
        reset: result.reset,
        page,
        fence: subscriber.fence,
        ...shared
      })
      if (!port.isActive(subscriber)) {
        return frame
      }
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.workView = undefined
      await refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return frame
    }
    const page = result.page
    const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
    if (!advanced) {
      await emitCaughtUp(port, subscriber, journal, emitCheckpoint, shared, frame)
      return frame
    }
    // Bound synchronous catch-up; older history remains available through paging.
    if (page.hasNewer && subscriber.snapshotCatchUp !== false) {
      return publishSnapshotFrame(port, subscriber, journal, subscriber.fence, shared)
    }
    await delivery.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: {
          cursor: page.window.nextCursor,
          items: page.items,
          removedItemIds: page.removedItemIds,
          submissions: page.submissions
        },
        fence: subscriber.fence,
        ...(page.latestTurn !== undefined ? { latestTurn: page.latestTurn } : {}),
        ...(page.actionablePromptIds !== undefined
          ? { actionablePromptIds: page.actionablePromptIds }
          : {}),
        ...(page.working !== undefined ? { working: page.working } : {}),
        ...(page.hasNewer ? { hasNewer: true as const } : {}),
        ...shared
      },
      // Withhold queue lists until final catch-up so consumed cards do not vanish before their bubbles arrive.
      { withholdQueued: page.hasNewer }
    )
    if (!port.isActive(subscriber)) {
      return frame
    }
    subscriber.cursor = page.window.nextCursor
    if (!page.hasNewer) {
      // The contiguous page already carries current fields and changed submissions.
      if (work && work.workViewKey() !== subscriber.workView) {
        await refreshPublishedWork(delivery, subscriber, journal, work, shared)
      }
      return frame
    }
  }
}

/** Every emission of a captured frame, restatements included, carries its own work and queue. */
function capturedPort(
  port: SubscriberDeliveryPort,
  journal: AgentSessionJournal,
  frame: SubscriberFrameCapture<unknown>
): SubscriberDeliveryPort {
  return {
    ...port,
    emit: (target, event, options) =>
      port.emit(target, event, {
        ...options,
        currentWork: frame.work,
        journal,
        ...(frame.queue ? { queuePublication: frame.queue } : {})
      })
  }
}

async function emitCaughtUp(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  emitCheckpoint: boolean,
  shared: {
    hostNow: number
    activity?: AgentSessionTurnActivity | null
  },
  frame: SubscriberFrameCapture<unknown>
): Promise<void> {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  // Ownership/exit changes without rows still require current-work restatement.
  const { work, queue } = frame
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    await refreshPublishedWork(
      capturedPort(port, journal, frame),
      subscriber,
      journal,
      work,
      shared
    )
    return
  }
  const queuedChanged = queue !== undefined && queue.value !== subscriber.queuePublication
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        ...shared
      },
      { currentWork: work, ...(queue ? { queuePublication: queue } : {}) }
    )
  }
}

export async function publishSubscriberSnapshot(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  fence: number,
  hostNow: number
): Promise<void> {
  await unlessSuperseded(publishSnapshotFrame(port, subscriber, journal, fence, { hostNow }))
}

async function publishSnapshotFrame(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  fence: number,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null }
): Promise<SubscriberFrameCapture<unknown> | undefined> {
  const reader = subscriberHistoryReader(subscriber)
  const frame = await captureSubscriberFrame(port, subscriber, journal, (work) =>
    readAgentSessionHydrationFrame(journal, fence, reader, work, true)
  )
  if (!frame) {
    return undefined
  }
  const delivery = capturedPort(port, journal, frame)
  const page = withPublishedWork(frame.value, frame.work)
  await delivery.emit(subscriber, {
    type: 'snapshot',
    sessionId: subscriber.sessionId,
    page,
    fence,
    hostNow: shared.hostNow,
    activity: port.activity(subscriber.sessionId)
  })
  if (!port.isActive(subscriber)) {
    return frame
  }
  subscriber.cursor = page.liveCursor ?? page.window.nextCursor
  subscriber.fence = fence
  // The replacement dropped client restatements; owe them until every follow-up lands.
  subscriber.workView = undefined
  await refreshPublishedWork(delivery, subscriber, journal, frame.work, shared)
  return frame
}
