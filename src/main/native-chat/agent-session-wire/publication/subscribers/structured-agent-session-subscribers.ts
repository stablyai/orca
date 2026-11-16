import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { subscriberDeliveryPort } from './agent-session-subscriber-delivery-port'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import { ForkMarkerSubscriptions } from './agent-session-fork-marker-delivery'
import type {
  AgentSessionSubscribeInput,
  Subscriber,
  AgentSessionSubscribersHooks
} from './agent-session-subscribe-input'

import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../../../shared/agent-session/agent-session-wire'
import {
  emitSubscriberFrame,
  subscriberCommandsChanged
} from './agent-session-subscriber-frame-fields'
import {
  deliverToSubscriber,
  publishSubscriberSnapshot,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import {
  publishSubscriberLiveText,
  republishSubscriberBackgroundTasks
} from './agent-session-live-publications'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { rememberSessionActivity } from './structured-agent-session-activity-retention'
import { resumeSubscriber } from './agent-session-stop-note-refresh'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'
import {
  SubscriberDeliveryLane,
  type SubscriberCatchUp,
  type SubscriberDeliveryRetention
} from './agent-session-subscriber-delivery-lane'
import { trackSubscriberRetention } from './agent-session-subscriber-retention'

// Advance subscriber cursors independently, sending resets or reducer-projected batches as needed.

export type { AgentSessionSubscribersHooks } from './agent-session-subscribe-input'

export class AgentSessionSubscribers {
  private readonly lanes = new WeakMap<Subscriber, SubscriberDeliveryLane>()
  private readonly bySession = new Map<string, Map<string, Subscriber>>()
  private readonly forkMarkers = new ForkMarkerSubscriptions(
    () => this.deliveryPort(),
    (id) => this.subscribers(id),
    () => this.now(),
    (id) => this.hooks.readForkJournal?.(id),
    (subscriber, journal) =>
      this.enqueue(subscriber, () => this.forkMarkers.refresh(subscriber, journal))
  )
  private readonly activityBySession = new Map<string, AgentSessionTurnActivity>()

  constructor(private readonly hooks: AgentSessionSubscribersHooks = {}) {
    trackSubscriberRetention(this)
  }

  /** What waits behind each subscriber's active delivery, for memory diagnostics. */
  retention(): SubscriberDeliveryRetention[] {
    const now = this.now()
    const lanes: SubscriberDeliveryRetention[] = []
    for (const session of this.bySession.values()) {
      for (const subscriber of session.values()) {
        const lane = this.lanes.get(subscriber)
        if (lane && !lane.idle) {
          lanes.push(lane.retention(now))
        }
      }
    }
    return lanes
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
      readForkMarker: () => this.hooks.readForkMarker?.(fields.sessionId),
      cursor: input.cursor ?? { epoch: liveCursor.epoch, sequence: 0 },
      boundedFrames: input.boundedFrames === true,
      readsCurrentRequests: input.readsCurrentRequests === true,
      snapshotCatchUp: input.snapshotCatchUp !== false
    }
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    subscriber.stopped = this.lane(subscriber).stopped
    const replaced = session.get(input.id)
    if (replaced) {
      this.lanes.get(replaced)?.clear()
    }
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    this.forkMarkers.add(subscriber)
    this.enqueue(subscriber, async () => {
      const hostNow = this.now()
      const port = this.deliveryPort(input.sessionId, journal)
      if (input.cursor) {
        await resumeSubscriber(port, subscriber, journal, hostNow, () =>
          this.forkMarkers.refresh(subscriber, journal, true)
        )
      } else {
        await publishSubscriberSnapshot(port, subscriber, journal, input.fence, hostNow)
        subscriber.forkMarkerView = JSON.stringify(subscriber.readForkMarker?.())
      }
      await publishSubscriberLiveText(this.deliveryPort(), {
        sessionId: input.sessionId,
        journal,
        fence: input.fence,
        items: this.hooks.readLiveText?.(input.sessionId) ?? [],
        subscribers: [subscriber],
        hostNow
      })
    })
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

  publishLiveText = (
    sessionId: string,
    journal: AgentSessionJournal,
    fence: number,
    items: readonly AgentJournalRenderItem[],
    targets = this.subscribers(sessionId)
  ): void => {
    const hostNow = this.now()
    for (const subscriber of targets) {
      if (this.isActive(subscriber)) {
        this.lane(subscriber).liveText({ journal, fence, items, hostNow })
      }
    }
  }

  /** What a request's frame captures with, outside any subscriber. */
  frameHooks = (sessionId: string, journal: AgentSessionJournal) =>
    this.deliveryPort(sessionId, journal).hooks

  async readQueuePublication(sessionId: string): Promise<QueuePublication | undefined> {
    return (await this.hooks.readQueuePublication?.(sessionId)) ?? undefined
  }

  deliverFrames(
    sessionId: string,
    journal: AgentSessionJournal,
    activity?: AgentSessionTurnActivity | null,
    queueChanged = true
  ): void {
    const hostNow = this.now()
    const port = this.deliveryPort(sessionId, journal, queueChanged)
    for (const subscriber of this.subscribers(sessionId)) {
      this.lane(subscriber).catchUp({
        journal,
        port,
        queueChanged,
        hostNow,
        ...(activity !== undefined ? { activity } : {})
      })
    }
  }

  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const hostNow = this.now()
    const port = this.deliveryPort(sessionId, journal)
    for (const subscriber of this.subscribers(sessionId)) {
      this.enqueue(subscriber, async () => {
        await publishSubscriberSnapshot(port, subscriber, journal, fence, hostNow)
        await publishSubscriberLiveText(this.deliveryPort(), {
          sessionId,
          journal,
          fence,
          items: this.hooks.readLiveText?.(sessionId) ?? [],
          subscribers: [subscriber],
          hostNow
        })
      })
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  republishBackgroundTasks(sessionId: string, fence: number): void {
    for (const subscriber of this.subscribers(sessionId)) {
      this.lane(subscriber).backgroundTasks(fence)
    }
  }

  republishCommands(retired?: (sessionId: string) => boolean): void {
    const hostNow = this.now()
    for (const sessionId of this.bySession.keys()) {
      for (const subscriber of this.subscribers(sessionId)) {
        const invalidated = subscriber.commandsOnRequest && retired?.(sessionId)
        if (invalidated || subscriberCommandsChanged(this.hooks, subscriber)) {
          this.enqueue(subscriber, () =>
            this.emit(subscriber, {
              type: 'batch',
              sessionId,
              batch: emptyAgentSessionBatch(subscriber.cursor),
              fence: subscriber.fence,
              hostNow,
              ...(invalidated ? { commandsChanged: true as const } : {})
            })
          )
        }
      }
    }
  }

  refreshForkSources(
    readJournal: (sessionId: string) => AgentSessionJournal | undefined,
    sourceIds?: readonly string[]
  ): void {
    this.forkMarkers.refreshSources(readJournal, sourceIds)
  }

  private subscribers = (sessionId: string): Subscriber[] => [
    ...(this.bySession.get(sessionId)?.values() ?? [])
  ]

  private now = (): number => this.hooks.now?.() ?? Date.now()

  private deliveryPort(
    sessionId?: string,
    journal?: AgentSessionJournal,
    queueChanged = true
  ): SubscriberDeliveryPort {
    return subscriberDeliveryPort(
      {
        hooks: this.hooks,
        emit: (target, event, options, hooks) => this.emit(target, event, options, hooks),
        isActive: this.isActive,
        activity: (id) => this.activityBySession.get(id) ?? null
      },
      sessionId,
      journal,
      queueChanged
    )
  }

  private isActive = (subscriber: Subscriber): boolean =>
    this.bySession.get(subscriber.sessionId)?.get(subscriber.id) === subscriber

  /** Dead transports must not obscure durable mutation outcomes or poison later publications. */
  private async emit(
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: Parameters<SubscriberDeliveryPort['emit']>[2],
    hooks = this.hooks
  ): Promise<void> {
    try {
      if (!this.isActive(subscriber)) {
        return
      }
      await emitSubscriberFrame(hooks, subscriber, event, {
        ...options,
        isActive: () => this.isActive(subscriber)
      })
      if (options?.historyView !== undefined && this.isActive(subscriber)) {
        subscriber.historyView = options.historyView
      }
    } catch (error) {
      // Nothing was sent; the newer commit's own delivery replaces the frame.
      if (error instanceof SubscriberFrameSuperseded) {
        throw error
      }
      this.fail(subscriber, error)
    }
  }

  private enqueue(subscriber: Subscriber, deliver: () => Promise<unknown>): void {
    this.lane(subscriber).ordered(deliver)
  }

  private lane(subscriber: Subscriber): SubscriberDeliveryLane {
    let lane = this.lanes.get(subscriber)
    if (!lane) {
      const { sessionId } = subscriber
      lane = new SubscriberDeliveryLane({
        catchUp: ({ journal, port, hostNow, activity }) =>
          deliverToSubscriber(port, {
            subscriber,
            journal,
            hostNow,
            emitCheckpoint: false,
            activity
          }),
        backgroundTasks: (fence) =>
          republishSubscriberBackgroundTasks(
            this.deliveryPort(),
            [subscriber],
            sessionId,
            fence,
            this.now()
          ),
        liveText: ({ journal, fence, items, hostNow }) =>
          publishSubscriberLiveText(this.deliveryPort(), {
            sessionId,
            journal,
            fence,
            items,
            subscribers: [subscriber],
            hostNow
          }),
        mergeCatchUp: (pending, next) => this.mergeCatchUp(sessionId, pending, next),
        runnable: () => this.isActive(subscriber),
        failed: (error) => {
          if (!(error instanceof SubscriberFrameSuperseded)) {
            this.fail(subscriber, error)
          }
        },
        now: this.now
      })
      this.lanes.set(subscriber, lane)
    }
    return lane
  }

  /** The newer fan-out's reads are fresher; a text-only commit never hides an owed queue read. */
  private mergeCatchUp(
    sessionId: string,
    pending: SubscriberCatchUp,
    next: SubscriberCatchUp
  ): SubscriberCatchUp | undefined {
    if (pending.journal !== next.journal) {
      return undefined
    }
    const queueChanged = pending.queueChanged || next.queueChanged
    const activity = next.activity !== undefined ? next.activity : pending.activity
    return {
      journal: next.journal,
      port:
        queueChanged === next.queueChanged
          ? next.port
          : this.deliveryPort(sessionId, next.journal, queueChanged),
      queueChanged,
      hostNow: next.hostNow,
      ...(activity !== undefined ? { activity } : {})
    }
  }

  /**
   * A dropped subscriber gets no more frames, so end its stream or the client never resubscribes.
   * An inactive subscriber was already ended, and a newer one may now own its id.
   */
  private fail(subscriber: Subscriber, error: unknown): void {
    if (!this.isActive(subscriber)) {
      return
    }
    this.drop(subscriber)
    subscriber.end?.(error)
  }

  private drop(subscriber: Subscriber): void {
    this.lanes.get(subscriber)?.clear()
    const session = this.bySession.get(subscriber.sessionId)
    session?.delete(subscriber.id)
    if (session?.size === 0) {
      this.bySession.delete(subscriber.sessionId)
      this.forkMarkers.delete(subscriber)
    }
  }
}
