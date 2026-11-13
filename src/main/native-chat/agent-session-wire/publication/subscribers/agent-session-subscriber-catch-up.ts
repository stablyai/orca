import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
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
  readAgentSessionHydrationPage
} from '../history/agent-session-history-page'
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

export async function deliverToSubscriber(
  port: SubscriberDeliveryPort,
  input: {
    subscriber: Subscriber
    journal: AgentSessionJournal
    hostNow: number
    emitCheckpoint: boolean
    activity?: AgentSessionTurnActivity | null | undefined
  }
): Promise<void> {
  const { subscriber, journal, hostNow, emitCheckpoint, activity } = input
  const checkpointActivity = emitCheckpoint ? port.activity(subscriber.sessionId) : undefined
  const publishedActivity = activity !== undefined ? activity : checkpointActivity
  const shared = {
    hostNow,
    ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
  }
  let work = (await port.hooks.readCurrentWork?.(subscriber.sessionId, journal)) ?? undefined
  if (!port.isActive(subscriber)) {
    return
  }
  const emit: SubscriberDeliveryPort['emit'] = (target, event, options) =>
    port.emit(target, event, { ...options, currentWork: work, journal })
  const delivery = { ...port, emit }
  // Caught up, so there are no rows to read: every publish behind a commit's own delivery.
  if (sameJournalCursor(subscriber.cursor, journal.cursor())) {
    await emitCaughtUp(delivery, subscriber, emitCheckpoint, shared, {
      journal,
      work
    })
    return
  }
  const reader = subscriberHistoryReader(subscriber)
  const readPage = createAgentSessionCatchUpReader(journal, reader)
  while (true) {
    const read = await readPage({
      sessionId: subscriber.sessionId,
      direction: 'after',
      cursor: subscriber.cursor,
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    work = await workThroughPage(port, subscriber.sessionId, journal, work, read.page)
    const result = withPublishedWorkResult(read, work)
    if (!result.ok) {
      const page = { ...result.page, fence: subscriber.fence }
      await emit(
        subscriber,
        {
          type: 'reset',
          sessionId: subscriber.sessionId,
          reset: result.reset,
          page,
          fence: subscriber.fence,
          ...shared
        },
        { journal }
      )
      if (!port.isActive(subscriber)) {
        return
      }
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      await refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return
    }
    if (!port.isActive(subscriber)) {
      return
    }
    const page = result.page
    const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
    if (!advanced) {
      await emitCaughtUp(delivery, subscriber, emitCheckpoint, shared, {
        journal,
        work
      })
      return
    }
    // Bound synchronous catch-up; older history remains available through paging.
    if (page.hasNewer && subscriber.snapshotCatchUp !== false) {
      const hydrated = await readAgentSessionHydrationPage(journal, subscriber.fence, reader)
      work = await workThroughPage(port, subscriber.sessionId, journal, work, hydrated)
      const tail = withPublishedWork(hydrated, work)
      await emit(
        subscriber,
        {
          type: 'snapshot',
          sessionId: subscriber.sessionId,
          page: tail,
          fence: subscriber.fence,
          hostNow,
          activity: port.activity(subscriber.sessionId)
        },
        { journal }
      )
      if (!port.isActive(subscriber)) {
        return
      }
      subscriber.cursor = tail.liveCursor ?? tail.window.nextCursor
      await refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return
    }
    await emit(
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
      return
    }
    subscriber.cursor = page.window.nextCursor
    if (!page.hasNewer || !port.isActive(subscriber)) {
      // The contiguous page already carries current fields and changed submissions.
      if (work && work.workViewKey() !== subscriber.workView) {
        await refreshPublishedWork(delivery, subscriber, journal, work, shared)
      }
      return
    }
  }
}

function pagePassedWork(page: AgentSessionHistoryPage, work: StructuredAgentSessionObservedWork) {
  const cursor = page.liveCursor ?? page.window.nextCursor
  return cursor.epoch !== work.cursor.epoch || cursor.sequence > work.cursor.sequence
}

/** Restated copies must not be older than the rows they replace, so re-answer work the page passed.
 *  A page holding a not-yet-adopted commit keeps its own rows; that commit's publish restates work. */
async function workThroughPage(
  port: SubscriberDeliveryPort,
  sessionId: string,
  journal: AgentSessionJournal,
  work: StructuredAgentSessionObservedWork | undefined,
  page: AgentSessionHistoryPage
): Promise<StructuredAgentSessionObservedWork | undefined> {
  if (!work || !pagePassedWork(page, work)) {
    return work
  }
  const current = (await port.hooks.readCurrentWork?.(sessionId, journal)) ?? undefined
  return current && !pagePassedWork(page, current) ? current : undefined
}

async function emitCaughtUp(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  emitCheckpoint: boolean,
  shared: {
    hostNow: number
    activity?: AgentSessionTurnActivity | null
  },
  current: {
    journal: AgentSessionJournal
    work: StructuredAgentSessionObservedWork | undefined
  }
): Promise<void> {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  // Ownership/exit changes without rows still require current-work restatement.
  const { work } = current
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    await refreshPublishedWork(port, subscriber, current.journal, work, shared)
    return
  }
  const queue = await port.hooks.readQueuePublication?.(subscriber.sessionId)
  const queuedChanged =
    port.hooks.readQueuePublication !== undefined && queue !== subscriber.queuePublication
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
      { currentWork: work, queuePublication: { value: queue } }
    )
  }
}

export async function publishSubscriberSnapshot(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  fence: number,
  answered: StructuredAgentSessionObservedWork | undefined,
  hostNow: number
): Promise<void> {
  const hydrated = await readAgentSessionHydrationPage(
    journal,
    fence,
    subscriberHistoryReader(subscriber)
  )
  const work = await workThroughPage(port, subscriber.sessionId, journal, answered, hydrated)
  const page = withPublishedWork(hydrated, work)
  if (!port.isActive(subscriber)) {
    return
  }
  await port.emit(
    subscriber,
    {
      type: 'snapshot',
      sessionId: subscriber.sessionId,
      page,
      fence,
      hostNow,
      activity: port.activity(subscriber.sessionId)
    },
    { currentWork: work, journal }
  )
  if (!port.isActive(subscriber)) {
    return
  }
  subscriber.cursor = page.liveCursor ?? page.window.nextCursor
  subscriber.fence = fence
  await refreshPublishedWork(port, subscriber, journal, work, { hostNow })
}
