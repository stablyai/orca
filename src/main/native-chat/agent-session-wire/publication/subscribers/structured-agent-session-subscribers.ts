import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
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
import { refreshDerivedStopNotes } from './agent-session-stop-note-refresh'

// Advance subscriber cursors independently, sending resets or reducer-projected batches as needed.

export type { AgentSessionSubscribersHooks } from './agent-session-subscribe-input'

export class AgentSessionSubscribers {
  private readonly deliveries = new WeakMap<Subscriber, Promise<void>>()
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

  constructor(private readonly hooks: AgentSessionSubscribersHooks = {}) {}

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
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    this.forkMarkers.add(subscriber)
    this.enqueue(subscriber, async () => {
      const hostNow = this.now()
      const port = this.deliveryPort(input.sessionId, journal)
      const work = (await port.hooks.readCurrentWork?.(input.sessionId, journal)) ?? undefined
      if (!this.isActive(subscriber)) {
        return
      }
      if (input.cursor) {
        await deliverToSubscriber(port, { subscriber, journal, hostNow, emitCheckpoint: true })
        await this.forkMarkers.refresh(subscriber, journal, true)
        await refreshDerivedStopNotes(port, subscriber, journal, hostNow, work)
      } else {
        await publishSubscriberSnapshot(port, subscriber, journal, input.fence, work, hostNow)
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
      this.enqueue(subscriber, () =>
        publishSubscriberLiveText(this.deliveryPort(), {
          sessionId,
          journal,
          fence,
          items,
          subscribers: [subscriber],
          hostNow
        })
      )
    }
  }

  async readQueuePublication(sessionId: string): Promise<QueuePublication | undefined> {
    return this.hooks.readQueuePublication?.(sessionId)
  }

  async readWorkAndQueue(sessionId: string, journal: AgentSessionJournal) {
    let work: StructuredAgentSessionObservedWork | null = null
    const queue = await this.hooks.readQueuePublication?.(sessionId, undefined, (value) => {
      work = value
    })
    // Discovery may fail before work was read; queue unavailability never erases valid work.
    work ??= (await this.hooks.readCurrentWork?.(sessionId, journal)) ?? null
    return { work, queue }
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
      this.enqueue(subscriber, () =>
        deliverToSubscriber(port, { subscriber, journal, hostNow, emitCheckpoint: false, activity })
      )
    }
  }

  snapshot(sessionId: string, journal: AgentSessionJournal, fence: number): void {
    const hostNow = this.now()
    const port = this.deliveryPort(sessionId, journal)
    for (const subscriber of this.subscribers(sessionId)) {
      this.enqueue(subscriber, async () => {
        const work = (await port.hooks.readCurrentWork?.(sessionId, journal)) ?? undefined
        await publishSubscriberSnapshot(port, subscriber, journal, fence, work, hostNow)
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
      this.enqueue(subscriber, () =>
        republishSubscriberBackgroundTasks(
          this.deliveryPort(),
          [subscriber],
          sessionId,
          fence,
          this.now()
        )
      )
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
      // A dropped subscriber gets no more frames, so end its stream or the client never resubscribes.
      this.drop(subscriber)
      subscriber.end?.(error)
    }
  }

  private enqueue(subscriber: Subscriber, deliver: () => Promise<void>): void {
    const previous = this.deliveries.get(subscriber) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        if (this.isActive(subscriber)) {
          await deliver()
        }
      })
      .catch(() => this.drop(subscriber))
    this.deliveries.set(subscriber, next)
    void next.finally(() => {
      if (this.deliveries.get(subscriber) === next) {
        this.deliveries.delete(subscriber)
      }
    })
  }

  private drop(subscriber: Subscriber): void {
    const session = this.bySession.get(subscriber.sessionId)
    session?.delete(subscriber.id)
    if (session?.size === 0) {
      this.bySession.delete(subscriber.sessionId)
      this.forkMarkers.delete(subscriber)
    }
  }
}
