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
import { createAgentSessionCatchUpReader } from './agent-session-history-page'
import {
  subscriberQueuedMessagesChanged,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { Subscriber } from './structured-agent-session-subscribers'

export type SubscriberDeliveryPort = {
  hooks: SubscriberFieldHooks & {
    readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  }
  emit: (
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: { withholdQueued?: boolean }
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
  // Caught up, so there are no rows to read: every publish behind a commit's own delivery.
  if (sameJournalCursor(subscriber.cursor, journal.cursor())) {
    emitCaughtUp(port, subscriber, emitCheckpoint, shared)
    return
  }
  const readPage = createAgentSessionCatchUpReader(journal)
  while (true) {
    const result = readPage({
      sessionId: subscriber.sessionId,
      direction: 'after',
      cursor: subscriber.cursor,
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    if (!result.ok) {
      const page = { ...result.page, fence: subscriber.fence }
      port.emit(subscriber, {
        type: 'reset',
        sessionId: subscriber.sessionId,
        reset: result.reset,
        page,
        fence: subscriber.fence,
        ...shared
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      return
    }
    const page = result.page
    const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
    if (!advanced) {
      emitCaughtUp(port, subscriber, emitCheckpoint, shared)
      return
    }
    port.emit(
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
        ...shared
      },
      // On a multi-page catch-up the draft list rides only the final page, or a
      // consumed card would vanish pages before its bubble arrives.
      { withholdQueued: page.hasNewer }
    )
    subscriber.cursor = page.window.nextCursor
    if (!page.hasNewer || !port.isActive(subscriber)) {
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
  }
): void {
  const commandsChanged =
    port.hooks.readCommands !== undefined &&
    (port.hooks.readCommands(subscriber.sessionId) ?? null) !== subscriber.commands
  const queuedChanged = subscriberQueuedMessagesChanged(port.hooks, subscriber)
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    port.emit(subscriber, {
      type: 'batch',
      sessionId: subscriber.sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence: subscriber.fence,
      ...shared
    })
  }
}
