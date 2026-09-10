// Per-subscriber cursors over one session's journal.
//
// Each subscriber advances independently: a client that connected two epochs
// ago gets a reset while a caught-up one gets a batch from the same publish.
// Nothing raw reaches a subscriber — every event carries reducer output.

import type {
  AgentJournalCursor,
  AgentJournalResetReason
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionBackgroundTaskState,
  type AgentSessionSlashCommand,
  type AgentSessionHandoffStatus,
  type AgentSessionSubscribeEvent,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHydrationPage
} from './agent-session-history-page'

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type AgentSessionSubscribeInput = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor?: AgentJournalCursor
}

type Subscriber = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor: AgentJournalCursor
  fence: number
  commands?: AgentSessionSlashCommand[] | null
}

export type AgentSessionSubscribersHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  /** Fires after any publication that can change journal content, whether or not anyone
   *  is subscribed to the transcript: session lists project status from this same edge. */
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
}

export class AgentSessionSubscribers {
  private readonly bySession = new Map<string, Map<string, Subscriber>>()
  private readonly activityBySession = new Map<string, AgentSessionTurnActivity>()

  constructor(private readonly hooks: AgentSessionSubscribersHooks = {}) {}

  /** Opens the stream with a bounded tail page or, when the client's cursor
   *  still resolves, with the rows it missed. Returns the disposer. */
  open(input: {
    id: string
    sessionId: string
    journal: AgentSessionJournal
    fence: number
    emit: AgentSessionSubscriberEmit
    cursor?: AgentJournalCursor
    handoff?: AgentSessionHandoffStatus
    backgroundTasks?: AgentSessionBackgroundTaskState | null
  }): () => void {
    const liveCursor = input.journal.cursor()
    const subscriber: Subscriber = {
      id: input.id,
      sessionId: input.sessionId,
      emit: input.emit,
      cursor: input.cursor ?? { epoch: liveCursor.epoch, sequence: 0 },
      fence: input.fence
    }
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    if (input.cursor) {
      this.deliver(subscriber, input.journal, input.handoff, true, input.backgroundTasks)
    } else {
      const page = readAgentSessionHydrationPage(input.journal, input.fence)
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId: input.sessionId,
        page,
        fence: input.fence,
        ...(input.handoff ? { handoff: input.handoff } : {}),
        ...(input.backgroundTasks !== undefined ? { backgroundTasks: input.backgroundTasks } : {}),
        ...this.activityField(input.sessionId)
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
    }
    return () => this.close(input.sessionId, input.id)
  }

  close(sessionId: string, id: string): void {
    const session = this.bySession.get(sessionId)
    const subscriber = session?.get(id)
    if (!session || !subscriber) {
      return
    }
    this.drop(subscriber)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  /** Fan out whatever each subscriber has not yet seen. */
  publish(
    sessionId: string,
    journal: AgentSessionJournal,
    activity?: AgentSessionTurnActivity | null
  ): void {
    if (activity !== undefined) {
      if (activity) {
        this.activityBySession.set(sessionId, activity)
      } else {
        this.activityBySession.delete(sessionId)
      }
    }
    for (const subscriber of this.subscribers(sessionId)) {
      this.deliver(subscriber, journal, undefined, false, undefined, activity)
    }
    if (activity === undefined) {
      this.hooks.onJournalPublished?.(sessionId, journal)
    }
  }

  /** Force every subscriber back to a bounded tail page — recovery, epoch
   *  rollover, an unreadable schema. */
  reset(
    sessionId: string,
    journal: AgentSessionJournal,
    reason: AgentJournalResetReason,
    fence: number,
    backgroundTasks?: AgentSessionBackgroundTaskState | null
  ): void {
    const page = readAgentSessionHydrationPage(journal, fence)
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, {
        type: 'reset',
        sessionId,
        reset: reason,
        page,
        fence,
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
        ...this.activityField(sessionId)
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  snapshot(
    sessionId: string,
    journal: AgentSessionJournal,
    fence: number,
    backgroundTasks?: AgentSessionBackgroundTaskState | null
  ): void {
    const page = readAgentSessionHydrationPage(journal, fence)
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId,
        page,
        fence,
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
        ...this.activityField(sessionId)
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  handoff(sessionId: string, fence: number, handoff: AgentSessionHandoffStatus): void {
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, {
        type: 'batch',
        sessionId,
        batch: {
          cursor: subscriber.cursor,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence,
        handoff
      })
      subscriber.fence = fence
    }
  }

  backgroundTasks(
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null,
    fence: number
  ): void {
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, {
        type: 'batch',
        sessionId,
        batch: {
          cursor: subscriber.cursor,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence,
        backgroundTasks: state
      })
      subscriber.fence = fence
    }
  }

  private subscribers(sessionId: string): Subscriber[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
  }

  private deliver(
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    handoff?: AgentSessionHandoffStatus,
    emitCheckpoint = false,
    backgroundTasks?: AgentSessionBackgroundTaskState | null,
    activity?: AgentSessionTurnActivity | null
  ): void {
    const checkpointActivity = emitCheckpoint
      ? this.activityField(subscriber.sessionId).activity
      : undefined
    const publishedActivity = activity !== undefined ? activity : checkpointActivity
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
        this.emit(subscriber, {
          type: 'reset',
          sessionId: subscriber.sessionId,
          reset: result.reset,
          page,
          fence: subscriber.fence,
          ...(handoff ? { handoff } : {}),
          ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
          ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
        })
        subscriber.cursor = page.liveCursor ?? page.window.nextCursor
        return
      }
      const page = result.page
      const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
      if (!advanced) {
        const commandsChanged =
          this.hooks.readCommands !== undefined &&
          (this.hooks.readCommands(subscriber.sessionId) ?? null) !== subscriber.commands
        if (handoff || emitCheckpoint || publishedActivity !== undefined || commandsChanged) {
          this.emit(subscriber, {
            type: 'batch',
            sessionId: subscriber.sessionId,
            batch: {
              cursor: page.window.nextCursor,
              items: [],
              removedItemIds: [],
              submissions: []
            },
            fence: subscriber.fence,
            ...(handoff ? { handoff } : {}),
            ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
            ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
          })
        }
        return
      }
      this.emit(subscriber, {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: {
          cursor: page.window.nextCursor,
          items: page.items,
          removedItemIds: page.removedItemIds,
          submissions: page.submissions
        },
        fence: subscriber.fence,
        ...(handoff ? { handoff } : {}),
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
        ...(publishedActivity !== undefined ? { activity: publishedActivity } : {})
      })
      subscriber.cursor = page.window.nextCursor
      if (!page.hasNewer || !this.isActive(subscriber)) {
        return
      }
    }
  }

  private isActive = (subscriber: Subscriber): boolean =>
    this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber

  /** A dead transport cannot be allowed to turn a durable mutation into an
   *  unknown outcome or poison every later publication. */
  private emit(subscriber: Subscriber, event: AgentSessionSubscribeEvent): void {
    try {
      const commands = this.hooks.readCommands?.(subscriber.sessionId) ?? null
      const includeCommands =
        this.hooks.readCommands !== undefined &&
        event.type !== 'end' &&
        (event.type !== 'batch' || commands !== subscriber.commands)
      subscriber.emit(includeCommands ? { ...event, commands: commands ?? null } : event)
      subscriber.commands = commands
    } catch {
      this.drop(subscriber)
    }
  }

  private drop(subscriber: Subscriber): void {
    const session = this.bySession.get(subscriber.sessionId)
    session?.delete(subscriber.id)
    if (session?.size === 0) {
      this.bySession.delete(subscriber.sessionId)
    }
  }

  private activityField(sessionId: string): { activity: AgentSessionTurnActivity | null } {
    return { activity: this.activityBySession.get(sessionId) ?? null }
  }
}
