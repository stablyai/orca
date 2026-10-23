// One subscriber's catch-up: page it forward to the journal head, or hand it
// the empty caught-up frame its per-emit fields still owe it. Split from the
// subscriber registry so the registry stays the bookkeeping and this stays the
// paging policy.

import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionSlashCommand,
  type AgentSessionSubscribeEvent,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { withPublishedWork, withPublishedWorkResult } from './agent-session-published-work'
import { refreshPublishedWork } from './agent-session-work-refresh'
import type { AgentSessionPublishedWork } from './agent-session-published-work'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHydrationPage
} from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import {
  subscriberCommandsChanged,
  subscriberQueuedMessagesChanged,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { Subscriber } from './structured-agent-session-subscribers'

export type SubscriberDeliveryPort = {
  hooks: SubscriberFieldHooks & {
    readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
    /** The host's projection of current work, which every frame's turn and prompt fields state. */
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
      currentWork?: AgentSessionPublishedWork
    }
  ) => void
  isActive: (subscriber: Subscriber) => boolean
  activity: (sessionId: string) => AgentSessionTurnActivity | null
}

export function deliverToSubscriber(
  port: SubscriberDeliveryPort,
  input: {
    subscriber: Subscriber
    journal: AgentSessionJournal
    hostNow: number
    emitCheckpoint: boolean
    activity?: AgentSessionTurnActivity | null | undefined
  }
): void {
  const { subscriber, journal, hostNow, emitCheckpoint, activity } = input
  const checkpointActivity = emitCheckpoint ? port.activity(subscriber.sessionId) : undefined
  const publishedActivity = activity !== undefined ? activity : checkpointActivity
  const shared = {
    hostNow,
    ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
  }
  const work = port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
  const emit: SubscriberDeliveryPort['emit'] = (target, event, options) =>
    port.emit(target, event, { ...options, currentWork: work })
  const delivery = { ...port, emit }
  // Caught up, so there are no rows to read: every publish behind a commit's own delivery.
  if (sameJournalCursor(subscriber.cursor, journal.cursor())) {
    emitCaughtUp(delivery, subscriber, emitCheckpoint, shared, {
      journal,
      work
    })
    return
  }
  const reader = subscriberHistoryReader(subscriber)
  const readPage = createAgentSessionCatchUpReader(journal, reader)
  while (true) {
    const result = withPublishedWorkResult(
      readPage({
        sessionId: subscriber.sessionId,
        direction: 'after',
        cursor: subscriber.cursor,
        limit: AGENT_SESSION_HISTORY_MAX_LIMIT
      }),
      work
    )
    if (!result.ok) {
      const page = { ...result.page, fence: subscriber.fence }
      emit(subscriber, {
        type: 'reset',
        sessionId: subscriber.sessionId,
        reset: result.reset,
        page,
        fence: subscriber.fence,
        ...shared
      })
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
    // Replaying an unbounded gap blocks the host; older rows remain available on scroll.
    if (page.hasNewer && subscriber.snapshotCatchUp !== false) {
      const tail = withPublishedWork(
        readAgentSessionHydrationPage(journal, subscriber.fence, reader),
        work
      )
      emit(subscriber, {
        type: 'snapshot',
        sessionId: subscriber.sessionId,
        page: tail,
        fence: subscriber.fence,
        hostNow,
        activity: port.activity(subscriber.sessionId)
      })
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
      // On a multi-page catch-up the draft list rides only the final page, or a
      // consumed card would vanish pages before its bubble arrives.
      { withholdQueued: page.hasNewer }
    )
    subscriber.cursor = page.window.nextCursor
    if (!page.hasNewer || !port.isActive(subscriber)) {
      refreshPublishedWork(delivery, subscriber, journal, work, shared)
      return
    }
  }
}

function emitCaughtUp(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  emitCheckpoint: boolean,
  shared: {
    hostNow: number
    activity?: AgentSessionTurnActivity | null
  },
  current: {
    journal: AgentSessionJournal
    work: StructuredAgentSessionCurrentWork | undefined
  }
): void {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  const queuedChanged = subscriberQueuedMessagesChanged(port.hooks, subscriber)
  // A generation that ended (or began) with no row, or an exit this host saw with no lease write,
  // changes what is current: the caught-up frame restates the view.
  const { work } = current
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    refreshPublishedWork(port, subscriber, current.journal, work, shared)
    return
  }
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        ...shared
      },
      { currentWork: work }
    )
  }
}
