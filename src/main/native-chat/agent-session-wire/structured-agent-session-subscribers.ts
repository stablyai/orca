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
  type AgentSessionHandoffStatus,
  type AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
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
}

export class AgentSessionSubscribers {
  private readonly bySession = new Map<string, Map<string, Subscriber>>()

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
      this.deliver(subscriber, input.journal, input.handoff, true)
    } else {
      const page = readAgentSessionHydrationPage(input.journal, input.fence)
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId: input.sessionId,
        page,
        fence: input.fence,
        ...(input.handoff ? { handoff: input.handoff } : {})
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
  publish(sessionId: string, journal: AgentSessionJournal): void {
    for (const subscriber of this.subscribers(sessionId)) {
      this.deliver(subscriber, journal)
    }
  }

  /** Force every subscriber back to a bounded tail page — recovery, epoch
   *  rollover, an unreadable schema. */
  reset(
    sessionId: string,
    journal: AgentSessionJournal,
    reason: AgentJournalResetReason,
    fence: number
  ): void {
    const page = readAgentSessionHydrationPage(journal, fence)
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, { type: 'reset', sessionId, reset: reason, page, fence })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
    }
  }

  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const page = readAgentSessionHydrationPage(journal, fence)
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, { type: 'snapshot', sessionId, page, fence })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
    }
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

  private subscribers(sessionId: string): Subscriber[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
  }

  private deliver(
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    handoff?: AgentSessionHandoffStatus,
    emitCheckpoint = false
  ): void {
    while (true) {
      const result = readAgentSessionHistory(journal, {
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
          ...(handoff ? { handoff } : {})
        })
        subscriber.cursor = page.liveCursor ?? page.window.nextCursor
        return
      }
      const page = result.page
      const advanced = page.window.nextCursor.sequence > subscriber.cursor.sequence
      if (!advanced) {
        if (handoff || emitCheckpoint) {
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
            ...(handoff ? { handoff } : {})
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
        ...(handoff ? { handoff } : {})
      })
      subscriber.cursor = page.window.nextCursor
      if (!page.hasNewer || !this.isActive(subscriber)) {
        return
      }
    }
  }

  private isActive(subscriber: Subscriber): boolean {
    return this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber
  }

  /** A dead transport cannot be allowed to turn a durable mutation into an
   *  unknown outcome or poison every later publication. */
  private emit(subscriber: Subscriber, event: AgentSessionSubscribeEvent): void {
    try {
      subscriber.emit(event)
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
}
