// Per-subscriber cursors over one session's journal.
//
// Each subscriber advances independently: a client that connected two epochs
// ago gets a reset while a caught-up one gets a batch from the same publish.
// Nothing raw reaches a subscriber — every event carries reducer output.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import {
  backgroundTaskFingerprint,
  buildSubscriberFrame,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import { deliverToSubscriber } from './agent-session-subscriber-catch-up'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { rememberSessionActivity } from './structured-agent-session-activity-retention'
import { refreshDerivedStopNotes } from './agent-session-stop-note-refresh'

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type AgentSessionSubscribeInput = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor?: AgentJournalCursor
}

export type Subscriber = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor: AgentJournalCursor
  fence: number
  commands?: AgentSessionSlashCommand[] | null
  /** The last draft list actually SENT — never advanced on a page that withheld
   *  it, or the final replacement would be suppressed by the identity dedup. */
  queuePublication?: QueuePublication
  /** Fingerprint of the background-task roster last SENT. */
  backgroundTasks?: string
}

export type AgentSessionSubscribersHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  /** Revision-stable per emit: an unchanged list keeps its reference, so token
   *  streams never re-serialize it; any draft-table write changes it. */
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  readBackgroundTasks?: SubscriberFieldHooks['readBackgroundTasks']
  /** Fires after publications that can change journal content. */
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
  now?: () => number
}

export class AgentSessionSubscribers {
  private readonly bySession = new Map<string, Map<string, Subscriber>>()
  private readonly activityBySession = new Map<string, AgentSessionTurnActivity>()

  constructor(private readonly hooks: AgentSessionSubscribersHooks = {}) {}

  get retainedActivityCountForTests(): number {
    return this.activityBySession.size
  }

  subscriberCountForTests(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0
  }

  open(input: {
    id: string
    sessionId: string
    journal: AgentSessionJournal
    fence: number
    emit: AgentSessionSubscriberEmit
    cursor?: AgentJournalCursor
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

    const hostNow = this.now()
    if (input.cursor) {
      this.deliver(subscriber, input.journal, hostNow, true)
      refreshDerivedStopNotes(
        {
          emit: (target, event) => this.emit(target, event),
          isActive: (target) => this.isActive(target)
        },
        subscriber,
        input.journal,
        hostNow
      )
    } else {
      const page = readAgentSessionHydrationPage(input.journal, input.fence)
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId: input.sessionId,
        page,
        fence: input.fence,
        hostNow,
        ...this.activityField(input.sessionId)
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
    }
    const { sessionId, id } = subscriber
    return () => this.close(sessionId, id)
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

  publish(
    sessionId: string,
    journal: AgentSessionJournal,
    activity?: AgentSessionTurnActivity | null
  ): void {
    if (activity !== undefined) {
      if (activity) {
        rememberSessionActivity(this.activityBySession, sessionId, activity)
      } else {
        this.activityBySession.delete(sessionId)
      }
    }
    const hostNow = this.now()
    for (const subscriber of this.subscribers(sessionId)) {
      this.deliver(subscriber, journal, hostNow, false, activity)
    }
    if (activity === undefined) {
      this.hooks.onJournalPublished?.(sessionId, journal)
    }
  }

  /** Every subscriber back to a bounded tail page. */
  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const page = readAgentSessionHydrationPage(journal, fence)
    const hostNow = this.now()
    for (const subscriber of this.subscribers(sessionId)) {
      this.emit(subscriber, {
        type: 'snapshot',
        sessionId,
        page,
        fence,
        hostNow,
        ...this.activityField(sessionId)
      })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  /** Re-sends the strip's roster to each subscriber whose last one differs; the session's child
   *  records changed. */
  republishBackgroundTasks(sessionId: string, fence: number): void {
    const state = this.hooks.readBackgroundTasks?.(sessionId)
    if (state === undefined) {
      return
    }
    const fingerprint = backgroundTaskFingerprint(state)
    const hostNow = this.now()
    for (const subscriber of this.subscribers(sessionId)) {
      if (subscriber.backgroundTasks === fingerprint) {
        continue
      }
      this.emit(subscriber, {
        type: 'batch',
        sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence,
        backgroundTasks: state,
        hostNow
      })
      subscriber.fence = fence
    }
  }

  /** Re-sends the `/` surface to each subscriber whose view of it is out of date. */
  republishCommands(): void {
    const hostNow = this.now()
    for (const sessionId of this.bySession.keys()) {
      for (const subscriber of this.subscribers(sessionId)) {
        if ((this.hooks.readCommands?.(sessionId) ?? null) !== subscriber.commands) {
          this.emit(subscriber, {
            type: 'batch',
            sessionId,
            batch: emptyAgentSessionBatch(subscriber.cursor),
            fence: subscriber.fence,
            hostNow
          })
        }
      }
    }
  }

  private subscribers(sessionId: string): Subscriber[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
  }

  private deliver(
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    hostNow: number,
    emitCheckpoint = false,
    activity?: AgentSessionTurnActivity | null
  ): void {
    deliverToSubscriber(
      {
        hooks: this.hooks,
        emit: (target, event, options) => this.emit(target, event, options),
        isActive: (target) => this.isActive(target),
        activity: (sessionId) => this.activityField(sessionId).activity
      },
      { subscriber, journal, hostNow, emitCheckpoint, activity }
    )
  }

  private now = (): number => this.hooks.now?.() ?? Date.now()

  private isActive = (subscriber: Subscriber): boolean =>
    this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber

  /** A dead transport cannot be allowed to turn a durable mutation into an
   *  unknown outcome or poison every later publication. */
  private emit(
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: { withholdQueued?: boolean }
  ): void {
    try {
      const built = buildSubscriberFrame(
        this.hooks,
        subscriber,
        event,
        options?.withholdQueued === true
      )
      subscriber.emit(built.frame)
      subscriber.commands = built.commands
      if (built.attachedQueued) {
        subscriber.queuePublication = built.queued
      }
      if (built.backgroundTasks !== undefined) {
        subscriber.backgroundTasks = built.backgroundTasks
      }
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
