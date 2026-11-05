import { emitCaughtUp } from './agent-session-subscriber-checkpoint'
import { journalDerivedRefreshPending } from '../agent-session-journal/journal-derived-read'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionSlashCommand,
  type AgentSessionSubscribeEvent,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session/agent-session-wire'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  withPublishedWork,
  withPublishedWorkResult,
  capturePublishedWork,
  capturePublishedWorkSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import { refreshPublishedWork } from './agent-session-work-refresh'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHydration
} from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import type { Subscriber } from './structured-agent-session-subscribers'

export type SubscriberDeliveryPort = {
  hooks: SubscriberFieldHooks & {
    isCurrentJournal?: (sessionId: string, journal: AgentSessionJournal) => boolean
    readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
    readCurrentWork?: (
      sessionId: string,
      journal: AgentSessionJournal
    ) => StructuredAgentSessionCurrentWork | undefined
  }
  emit: (
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: {
      withholdQueued?: boolean
      journal?: AgentSessionJournal
      currentWork?: AgentSessionPublishedWork
      historyView?: string
    }
  ) => void
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
  const refreshed = journalDerivedRefreshPending(journal)
    ? await readAgentSessionHydration(
        journal,
        subscriber.fence,
        subscriberHistoryReader(subscriber),
        undefined,
        () => port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
      )
    : undefined
  if (
    !port.isActive(subscriber) ||
    port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false
  ) {
    return
  }
  const checkpointActivity = emitCheckpoint ? port.activity(subscriber.sessionId) : undefined
  const publishedActivity = activity !== undefined ? activity : checkpointActivity
  const shared = {
    hostNow,
    ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
  }
  let work: AgentSessionPublishedWork | undefined =
    refreshed?.work ?? port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
  const emit: SubscriberDeliveryPort['emit'] = (target, event, options) =>
    port.emit(target, event, { ...options, currentWork: work, journal })
  const delivery = { ...port, emit }
  let view: Pick<
    ReturnType<AgentSessionJournal['publicRead']>,
    'snapshot' | 'normalizationKey' | 'currentSnapshot'
  > = journal.publicRead()
  if (
    subscriber.snapshotCatchUp !== false &&
    subscriber.readsCurrentRequests &&
    subscriber.cursor.epoch === journal.epoch &&
    view.normalizationKey !== '' &&
    subscriber.historyView !== view.normalizationKey
  ) {
    const pending =
      refreshed?.view === journal.publicRead()
        ? refreshed
        : readAgentSessionHydration(
            journal,
            subscriber.fence,
            subscriberHistoryReader(subscriber),
            undefined,
            () => port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
          )
    const hydration = pending instanceof Promise ? await pending : pending
    view = hydration.view
    work = hydration.work
    const page = withPublishedWork(hydration.page, work)
    if (
      !port.isActive(subscriber) ||
      port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false ||
      journal.publicRead() !== view
    ) {
      return
    }
    emit(
      subscriber,
      {
        type: 'snapshot',
        sessionId: subscriber.sessionId,
        page,
        fence: subscriber.fence,
        ...shared
      },
      { historyView: view.normalizationKey }
    )
    if (port.isActive(subscriber)) {
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      refreshPublishedWork(delivery, subscriber, journal, work, shared)
    }
    return
  }
  // Caught up, so there are no rows to read: every publish behind a commit's own delivery.
  if (sameJournalCursor(subscriber.cursor, journal.cursor())) {
    emitCaughtUp(delivery, subscriber, emitCheckpoint, shared, {
      journal,
      work
    })
    return
  }
  const reader = subscriberHistoryReader(subscriber)
  const readPage = createAgentSessionCatchUpReader(
    journal,
    reader,
    view,
    (snapshot, capturedView) => {
      view = capturedView
      work = capturePublishedWork(
        snapshot,
        port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
      )
      return (result) => withPublishedWorkResult(result, work)
    },
    function* (snapshot, capturedView) {
      view = capturedView
      work = yield* capturePublishedWorkSteps(
        snapshot,
        port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
      )
      return (result) => withPublishedWorkResult(result, work)
    },
    refreshed !== undefined
  )
  while (true) {
    const reading = { ...subscriber.cursor }
    const fence = subscriber.fence
    const result = await readPage({
      sessionId: subscriber.sessionId,
      direction: 'after',
      cursor: subscriber.cursor,
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    if (
      !port.isActive(subscriber) ||
      port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false ||
      subscriber.fence !== fence ||
      !sameJournalCursor(subscriber.cursor, reading)
    ) {
      return
    }
    if (!result.ok) {
      const page = { ...result.page, fence: subscriber.fence }
      emit(
        subscriber,
        {
          type: 'reset',
          sessionId: subscriber.sessionId,
          reset: result.reset,
          page,
          fence: subscriber.fence,
          ...shared
        },
        { historyView: view.normalizationKey }
      )
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return
    }
    const page = result.page
    const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
    if (!advanced) {
      emitCaughtUp(delivery, subscriber, emitCheckpoint, shared, {
        journal,
        work
      })
      return
    }
    // Bound synchronous catch-up; older history remains available through paging.
    if (page.hasNewer && subscriber.snapshotCatchUp !== false) {
      view = journal.publicRead()
      work = port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
      const pending = readAgentSessionHydration(
        journal,
        subscriber.fence,
        reader,
        (view) => view.snapshot,
        () => port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
      )
      const hydration = pending instanceof Promise ? await pending : pending
      view = hydration.view
      work = hydration.work
      const tail = withPublishedWork(hydration.page, work)
      if (
        !port.isActive(subscriber) ||
        port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false ||
        journal.publicRead() !== view
      ) {
        return
      }
      emit(
        subscriber,
        {
          type: 'snapshot',
          sessionId: subscriber.sessionId,
          page: tail,
          fence: subscriber.fence,
          hostNow,
          activity: port.activity(subscriber.sessionId)
        },
        { historyView: view.normalizationKey }
      )
      subscriber.cursor = tail.liveCursor ?? tail.window.nextCursor
      refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return
    }
    emit(
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
    subscriber.cursor = page.window.nextCursor
    if (!page.hasNewer || !port.isActive(subscriber)) {
      // The contiguous page already carries current fields and changed submissions.
      if (work && work.workViewKey() !== subscriber.workView) {
        refreshPublishedWork(delivery, subscriber, journal, work, shared)
      }
      return
    }
  }
}
