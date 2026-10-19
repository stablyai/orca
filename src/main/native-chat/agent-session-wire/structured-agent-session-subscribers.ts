import type { CurrentRequestsSubscriber } from './agent-session-current-requests'
// Per-subscriber cursors over one session's journal.
//
// Each subscriber advances independently: a client that connected two epochs
// ago gets a reset while a caught-up one gets a batch from the same publish.
// Nothing raw reaches a subscriber — every event carries reducer output.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import {
  backgroundTaskFingerprint,
  emitSubscriberFrame,
  subscriberCommandsChanged,
  type SubscriberFieldHooks,
  type SubscriberFieldState
} from './agent-session-subscriber-frame-fields'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import {
  deliverToSubscriber,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { withPublishedWork } from './agent-session-published-work'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { rememberSessionActivity } from './structured-agent-session-activity-retention'
import { refreshDerivedStopNotes } from './agent-session-stop-note-refresh'
import { refreshPublishedWork } from './agent-session-work-refresh'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type AgentSessionSubscribeInput = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor?: AgentJournalCursor
  /** Every frame to fit a phone's bridge frame; the RPC sets it for every phone. */
  boundedFrames?: boolean
  projectQueuePublication?: SubscriberFieldState['projectQueuePublication']
  readsCurrentRequests?: boolean
  /** False for desktops that need exact replay to keep send echoes and current requests. */
  snapshotCatchUp?: boolean
}

export type Subscriber = CurrentRequestsSubscriber & {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor: AgentJournalCursor
  fence: number
  boundedFrames: boolean
  projectQueuePublication?: SubscriberFieldState['projectQueuePublication']
  snapshotCatchUp?: boolean
  commands?: AgentSessionSlashCommand[] | null
  /** Canonical publication last sent — never advanced on a page that withheld
   *  it, or the final replacement would be suppressed by the identity dedup. */
  queuePublication?: QueuePublication
  /** Fingerprint of the background-task roster last SENT. */
  backgroundTasks?: string
  /** The current-work view the last frame's fields were read under
   *  (`StructuredAgentSessionCurrentWork.viewKey`); a change with no row still owes a frame. */
  workView?: string
}

export type AgentSessionSubscribersHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  /** Revision-stable per emit: an unchanged list keeps its reference, so token
   *  streams never re-serialize it; any draft-table write changes it. */
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  readBackgroundTasks?: SubscriberFieldHooks['readBackgroundTasks']
  /** Fires after publications that can change journal content. */
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
  /** The host's projection of current work (`structuredAgentSessionCurrentWork`), which every
   *  page and frame states as its turn and prompt fields. */
  readCurrentWork?: (
    sessionId: string,
    journal: AgentSessionJournal
  ) => StructuredAgentSessionCurrentWork | undefined
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

  open(
    input: AgentSessionSubscribeInput & { journal: AgentSessionJournal; fence: number }
  ): () => void {
    const liveCursor = input.journal.cursor()
    const subscriber: Subscriber = {
      id: input.id,
      sessionId: input.sessionId,
      emit: input.emit,
      cursor: input.cursor ?? { epoch: liveCursor.epoch, sequence: 0 },
      fence: input.fence,
      boundedFrames: input.boundedFrames === true,
      projectQueuePublication: input.projectQueuePublication,
      readsCurrentRequests: input.readsCurrentRequests === true,
      snapshotCatchUp: input.snapshotCatchUp !== false
    }
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    const hostNow = this.now()
    if (input.cursor) {
      this.deliver(subscriber, input.journal, hostNow, true)
      refreshDerivedStopNotes(
        this.deliveryPort(),
        subscriber,
        input.journal,
        hostNow,
        this.hooks.readCurrentWork?.(input.sessionId, input.journal)
      )
    } else {
      const work = this.hooks.readCurrentWork?.(input.sessionId, input.journal)
      const page = withPublishedWork(
        readAgentSessionHydrationPage(
          input.journal,
          input.fence,
          subscriberHistoryReader(subscriber)
        ),
        work
      )
      this.emit(
        subscriber,
        {
          type: 'snapshot',
          sessionId: input.sessionId,
          page,
          fence: input.fence,
          hostNow,
          ...this.activityField(input.sessionId)
        },
        { currentWork: work }
      )
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      refreshPublishedWork(this.deliveryPort(), subscriber, input.journal, work, { hostNow })
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
    this.deliverFrames(sessionId, journal, activity)
    if (activity === undefined) {
      this.hooks.onJournalPublished?.(sessionId, journal)
    }
  }

  /** The queue as frames publish it, for a history page to read the same. */
  readQueuePublication(sessionId: string): QueuePublication | undefined {
    return this.hooks.readQueuePublication?.(sessionId)
  }

  /** Each subscriber's frame for what changed, with none of a journal write's other edges. */
  deliverFrames(
    sessionId: string,
    journal: AgentSessionJournal,
    activity?: AgentSessionTurnActivity | null
  ): void {
    const hostNow = this.now()
    for (const subscriber of this.subscribers(sessionId)) {
      this.deliver(subscriber, journal, hostNow, false, activity)
    }
  }

  /** Every subscriber back to a bounded tail page. */
  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const work = this.hooks.readCurrentWork?.(sessionId, journal)
    // Read once per item form, since bounded-frame subscribers size their page by theirs.
    let storedPage: AgentSessionHistoryPage | undefined
    let boundedPage: AgentSessionHistoryPage | undefined
    const read = (subscriber: Subscriber): AgentSessionHistoryPage =>
      withPublishedWork(
        readAgentSessionHydrationPage(journal, fence, subscriberHistoryReader(subscriber)),
        work
      )
    const pageFor = (subscriber: Subscriber): AgentSessionHistoryPage =>
      subscriber.boundedFrames
        ? (boundedPage ??= read(subscriber))
        : (storedPage ??= read(subscriber))
    const hostNow = this.now()
    for (const subscriber of this.subscribers(sessionId)) {
      const page = pageFor(subscriber)
      this.emit(
        subscriber,
        {
          type: 'snapshot',
          sessionId,
          page,
          fence,
          hostNow,
          ...this.activityField(sessionId)
        },
        { currentWork: work }
      )
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
      refreshPublishedWork(this.deliveryPort(), subscriber, journal, work, { hostNow })
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
        if (subscriberCommandsChanged(this.hooks, subscriber)) {
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
    deliverToSubscriber(this.deliveryPort(), {
      subscriber,
      journal,
      hostNow,
      emitCheckpoint,
      activity
    })
  }

  private now = (): number => this.hooks.now?.() ?? Date.now()

  private deliveryPort(): SubscriberDeliveryPort {
    return {
      hooks: this.hooks,
      emit: (target, event, options) => this.emit(target, event, options),
      isActive: this.isActive,
      activity: (sessionId) => this.activityField(sessionId).activity
    }
  }

  private isActive = (subscriber: Subscriber): boolean =>
    this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber

  /** A dead transport cannot be allowed to turn a durable mutation into an
   *  unknown outcome or poison every later publication. */
  private emit(
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: Parameters<SubscriberDeliveryPort['emit']>[2]
  ): void {
    try {
      emitSubscriberFrame(this.hooks, subscriber, event, options)
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
