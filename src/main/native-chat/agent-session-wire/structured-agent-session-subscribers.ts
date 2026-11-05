import { journalDerivedRefreshPending } from '../agent-session-journal/journal-derived-read'
import { deliverReplacement } from './agent-session-replacement-delivery'
import { hydrateSubscriber } from './agent-session-subscriber-hydration'
import { safeSubscriberFrameSteps } from './agent-session-subscriber-frame-fields'
import { queueSubscriberDelivery } from './agent-session-subscriber-delivery'
import type { AgentSessionSubscribeInput } from './agent-session-subscribe-input'
import type { CurrentRequestsSubscriber } from './agent-session-current-requests'
// Advance subscriber cursors independently, sending resets or reducer-projected batches as needed.
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../shared/agent-session/agent-session-wire'
import {
  emitSubscriberFrame,
  subscriberCommandsChanged,
  type SubscriberFieldHooks,
  type SubscriberFieldState
} from './agent-session-subscriber-frame-fields'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import type {
  deliverToSubscriber,
  SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { readAgentSessionHydration } from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { rememberSessionActivity } from './structured-agent-session-activity-retention'
import { refreshDerivedStopNoteSteps } from './agent-session-stop-note-refresh'
import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import type { HistoryReader } from './agent-session-history-page-bounds'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
export type { AgentSessionSubscribeInput } from './agent-session-subscribe-input'
// Advance subscriber cursors independently, sending resets or reducer-projected batches as needed.

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type Subscriber = CurrentRequestsSubscriber &
  SubscriberFieldState & {
    id: string
    emit: AgentSessionSubscriberEmit
    cursor: AgentJournalCursor
    fence: number
    readHistorySnapshot?: HistoryReader['snapshot']
    readHistorySnapshotSteps?: HistoryReader['snapshotSteps']
    readQueueSourceIds?: HistoryReader['queueSourceIds']
    snapshotCatchUp?: boolean
    /** Last frame’s current-work key; row-free changes still require a frame. */
    workView?: string
    /** Semantic history baseline actually emitted, independent of token/row progress. */
    historyView?: string
    delivery?: Promise<void>
    pendingDelivery?: Omit<Parameters<typeof deliverToSubscriber>[1], 'subscriber'>
  }

export type AgentSessionSubscribersHooks = {
  isCurrentJournal?: (sessionId: string, journal: AgentSessionJournal) => boolean
  readJournal?: (sessionId: string) => AgentSessionJournal | undefined
  readCommands?: SubscriberFieldHooks['readCommands']
  /** Stable identity avoids serialization until queue changes. */
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  readQueuePublicationSteps?: SubscriberFieldHooks['readQueuePublicationSteps']
  readBackgroundTasks?: SubscriberFieldHooks['readBackgroundTasks']
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
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
    const { journal, ...fields } = input
    const liveCursor = journal.cursor()
    const subscriber: Subscriber = {
      ...fields,
      cursor: input.cursor ?? { epoch: liveCursor.epoch, sequence: 0 },
      boundedFrames: input.boundedFrames === true,
      readsCurrentRequests: input.readsCurrentRequests === true,
      snapshotCatchUp: input.snapshotCatchUp !== false
    }
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    const hostNow = this.now()
    if (input.cursor) {
      this.deliver(subscriber, input.journal, hostNow, true)
    } else {
      this.hydrate(subscriber, journal, hostNow)
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

  readQueuePublication(sessionId: string): QueuePublication | undefined {
    return this.hooks.readQueuePublication?.(sessionId)
  }

  readQueuePublicationFinite(sessionId: string): Promise<QueuePublication | undefined> {
    return this.hooks.readQueuePublicationSteps
      ? finishJournalStepsAsync(this.hooks.readQueuePublicationSteps(sessionId))
      : Promise.resolve(this.hooks.readQueuePublication?.(sessionId))
  }

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

  deliverReplacement(sessionId: string, journal: AgentSessionJournal): Promise<void> {
    return deliverReplacement(this.deliveryPort(), this.subscribers(sessionId), journal, this.now())
  }

  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const hostNow = this.now()
    const pages = new Map<HistoryReader, ReturnType<typeof readAgentSessionHydration>>()
    for (const subscriber of this.subscribers(sessionId)) {
      subscriber.fence = fence
      const reader = subscriberHistoryReader(subscriber)
      let prepared = pages.get(reader)
      if (!prepared) {
        prepared = readAgentSessionHydration(journal, fence, reader, undefined, () =>
          this.hooks.readCurrentWork?.(sessionId, journal)
        )
        pages.set(reader, prepared)
      }
      this.hydrate(subscriber, journal, hostNow, prepared)
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  republishBackgroundTasks(sessionId: string, fence: number): void {
    const state = this.hooks.readBackgroundTasks?.(sessionId)
    if (state === undefined) {
      return
    }
    const fingerprint = JSON.stringify(state)
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

  republishCommands(retired?: (sessionId: string) => boolean): void {
    const hostNow = this.now()
    for (const sessionId of this.bySession.keys()) {
      for (const subscriber of this.subscribers(sessionId)) {
        const invalidated = subscriber.commandsOnRequest && retired?.(sessionId)
        if (invalidated || subscriberCommandsChanged(this.hooks, subscriber)) {
          this.emit(subscriber, {
            type: 'batch',
            sessionId,
            batch: emptyAgentSessionBatch(subscriber.cursor),
            fence: subscriber.fence,
            hostNow,
            ...(invalidated ? { commandsChanged: true as const } : {})
          })
        }
      }
    }
  }

  private hydrate(
    ...args: Parameters<typeof hydrateSubscriber> extends [unknown, ...infer Rest] ? Rest : never
  ): void {
    hydrateSubscriber(this.deliveryPort(), ...args)
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
    queueSubscriberDelivery(
      this.deliveryPort(),
      subscriber,
      { journal, hostNow, emitCheckpoint, activity },
      (pending) => {
        return finishJournalStepsAsync(
          refreshDerivedStopNoteSteps(
            this.deliveryPort(),
            subscriber,
            pending.journal,
            pending.hostNow,
            this.hooks.readCurrentWork?.(subscriber.sessionId, pending.journal)
          )
        )
      }
    )
  }

  private now = (): number => this.hooks.now?.() ?? Date.now()

  private deliveryPort(): SubscriberDeliveryPort {
    return {
      hooks: this.hooks,
      emit: (target, event, options) => this.emit(target, event, options),
      emitSteps: (target, event, options) =>
        safeSubscriberFrameSteps(
          this.hooks,
          target,
          event,
          options,
          this.isActive,
          () => this.drop(target),
          () => {
            if (options?.journal && this.isActive(target)) {
              this.deliver(target, options.journal, this.now(), true)
            }
          }
        ),
      close: (target) => this.close(target.sessionId, target.id),
      isActive: this.isActive,
      activity: (sessionId) => this.activityBySession.get(sessionId) ?? null
    }
  }

  private isActive = (subscriber: Subscriber): boolean =>
    this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber

  /** Dead transports must not obscure durable mutation outcomes or poison later publications. */
  private emit(
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: Parameters<SubscriberDeliveryPort['emit']>[2]
  ): void {
    const journal = options?.journal ?? this.hooks.readJournal?.(subscriber.sessionId)
    if (journal && journalDerivedRefreshPending(journal)) {
      void journal
        .readInOrder(() =>
          finishJournalStepsAsync(this.deliveryPort().emitSteps!(subscriber, event, options))
        )
        .catch(() => this.drop(subscriber))
      return
    }
    try {
      emitSubscriberFrame(this.hooks, subscriber, event, options)
      if (options?.historyView !== undefined && this.isActive(subscriber)) {
        subscriber.historyView = options.historyView
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
}
