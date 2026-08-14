// Per-subscriber cursors over one session's journal.
//
// Each subscriber advances independently: a client that connected two epochs
// ago gets a reset while a caught-up one gets a batch from the same publish.
// Nothing raw reaches a subscriber — every event carries reducer output.

import type {
  AgentJournalCursor,
  AgentJournalResetReason
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHandoffStatus,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'

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

  /** Opens the stream with a snapshot or, when the client's cursor still
   *  resolves, with the rows it missed. Returns the disposer. */
  open(input: {
    id: string
    sessionId: string
    journal: AgentSessionJournal
    fence: number
    emit: AgentSessionSubscriberEmit
    cursor?: AgentJournalCursor
    handoff?: AgentSessionHandoffStatus
  }): () => void {
    const snapshot = input.journal.snapshot()
    const subscriber: Subscriber = {
      id: input.id,
      sessionId: input.sessionId,
      emit: input.emit,
      cursor: input.cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      fence: input.fence
    }
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    if (input.cursor) {
      this.deliver(subscriber, input.journal, input.handoff)
    } else {
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId: input.sessionId,
        snapshot,
        fence: input.fence,
        ...(input.handoff ? { handoff: input.handoff } : {})
      })
      subscriber.cursor = snapshot.cursor
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

  /** Force every subscriber back to a clean snapshot — recovery, epoch
   *  rollover, an unreadable schema. */
  reset(
    sessionId: string,
    journal: AgentSessionJournal,
    reason: AgentJournalResetReason,
    fence: number
  ): void {
    const snapshot = journal.snapshot()
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, { type: 'reset', sessionId, reset: reason, snapshot, fence })
      subscriber.cursor = snapshot.cursor
      subscriber.fence = fence
    }
  }

  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const snapshot = journal.snapshot()
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, { type: 'snapshot', sessionId, snapshot, fence })
      subscriber.cursor = snapshot.cursor
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
    handoff?: AgentSessionHandoffStatus
  ): void {
    const since = journal.readSince(subscriber.cursor)
    const snapshot = journal.snapshot()
    if (!since.ok) {
      this.emit(subscriber, {
        type: 'reset',
        sessionId: subscriber.sessionId,
        reset: since.reset,
        snapshot,
        fence: subscriber.fence,
        ...(handoff ? { handoff } : {})
      })
      subscriber.cursor = snapshot.cursor
      return
    }
    if (since.rows.length === 0) {
      if (handoff) {
        this.emit(subscriber, {
          type: 'batch',
          sessionId: subscriber.sessionId,
          batch: {
            cursor: snapshot.cursor,
            items: [],
            removedItemIds: [],
            submissions: []
          },
          fence: subscriber.fence,
          handoff
        })
      }
      return
    }
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot,
      afterSequence: subscriber.cursor.sequence
    })
    if (!projected.ok) {
      this.emit(subscriber, {
        type: 'reset',
        sessionId: subscriber.sessionId,
        reset: projected.reset,
        snapshot,
        fence: subscriber.fence,
        ...(handoff ? { handoff } : {})
      })
      subscriber.cursor = snapshot.cursor
      return
    }
    this.emit(subscriber, {
      type: 'batch',
      sessionId: subscriber.sessionId,
      batch: projected.batch,
      ...(handoff ? { fence: subscriber.fence } : {}),
      ...(handoff ? { handoff } : {})
    })
    subscriber.cursor = projected.batch.cursor
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
