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
  publishSubscriberSnapshot,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import * as liveText from './agent-session-subscriber-live-text'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { rememberLatestPerSession } from './structured-agent-session-activity-retention'
import { resumeSubscriber } from './agent-session-stop-note-refresh'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'
import type { SubscriberDeliveryRetention } from './agent-session-subscriber-delivery-lane'
import { SubscriberLanes } from './agent-session-subscriber-lane-runners'
import { trackSubscriberRetention } from './agent-session-subscriber-retention'
import { AgentSessionPromptSuggestionDelivery } from './agent-session-prompt-suggestion-delivery'

// Advance subscriber cursors independently, sending resets or reducer-projected batches as needed.

export type { AgentSessionSubscribersHooks } from './agent-session-subscribe-input'

export class AgentSessionSubscribers {
  private readonly lanes = new SubscriberLanes({
    deliveryPort: () => this.deliveryPort(),
    now: () => this.now(),
    isActive: (subscriber) => this.isActive(subscriber),
    fail: (subscriber, error) => this.fail(subscriber, error)
  })
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
  private readonly shownViewers = new liveText.LiveTextForShownViewers()
  readonly promptSuggestions = new AgentSessionPromptSuggestionDelivery({
    subscribers: (sessionId) => this.subscribers(sessionId),
    send: (subscriber, event) => this.enqueue(subscriber, () => this.emit(subscriber, event())),
    now: () => this.now(),
    onInterestChanged: (id, wanted) => this.hooks.onPromptSuggestionInterest?.(id, wanted)
  })

  constructor(private readonly hooks: AgentSessionSubscribersHooks = {}) {
    trackSubscriberRetention(this)
  }

  /** What waits behind each subscriber's active delivery, for memory diagnostics. */
  retention(counted: Set<object>): SubscriberDeliveryRetention[] {
    return this.lanes.retention(this.bySession, this.now(), counted)
  }

  subscriberCount(sessionId: string): number {
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
    subscriber.stopped = this.lanes.of(subscriber).stopped
    const replaced = session.get(input.id)
    if (replaced) {
      this.lanes.clear(replaced)
    }
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)
    this.shownViewers.watch(subscriber, replaced)

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
      await liveText.publishSubscriberLiveText(this.deliveryPort(), {
        sessionId: input.sessionId,
        journal,
        fence: input.fence,
        items: this.sentLiveText(subscriber, input.sessionId, journal),
        subscribers: [subscriber],
        hostNow
      })
    })
    this.promptSuggestions.opened(subscriber)
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
    rememberLatestPerSession(this.activityBySession, sessionId, activity)
    this.deliverFrames(sessionId, journal, activity)
    if (activity === undefined) {
      this.hooks.onJournalPublished?.(sessionId, journal)
    }
  }

  publishLiveText = (
    sessionId: string,
    journal: AgentSessionJournal,
    fence: number,
    read: liveText.SubscriberLiveTextSource,
    all: readonly Subscriber[] = this.subscribers(sessionId)
  ): void => {
    const republish = (only: readonly Subscriber[]) =>
      this.publishLiveText(sessionId, journal, fence, read, only)
    const targets = this.shownViewers.shown(sessionId, all, republish).filter(this.isActive)
    const items = targets.length > 0 ? liveText.liveTextFor(read, targets) : []
    const live = { journal, fence, items, hostNow: this.now() }
    // Checked per subscriber, in case ending one ends another mid fan-out.
    targets.forEach((target) => this.isActive(target) && this.lanes.of(target).liveText(live))
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
    let owedQueue: SubscriberDeliveryPort | undefined
    // Subscribers whose waiting catch-up still owes a queue read share one port for it.
    const queuePort = () =>
      queueChanged ? port : (owedQueue ??= this.deliveryPort(sessionId, journal, true))
    for (const subscriber of this.subscribers(sessionId)) {
      this.lanes.of(subscriber).catchUp({
        journal,
        port,
        queuePort,
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
        await liveText.publishSubscriberLiveText(this.deliveryPort(), {
          sessionId,
          journal,
          fence,
          items: this.sentLiveText(subscriber, sessionId, journal),
          subscribers: [subscriber],
          hostNow
        })
      })
    }
    this.hooks.onJournalPublished?.(sessionId, journal)
  }

  republishBackgroundTasks(sessionId: string, fence: number): void {
    for (const subscriber of this.subscribers(sessionId)) {
      this.lanes.of(subscriber).backgroundTasks(fence)
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

  liveTextReaders = (sessionId: string) =>
    liveText.sessionLiveTextReaders(this.bySession.get(sessionId))
  /** Live text an opening or snapshot sends itself counts against its subscriber's cap. */
  private sentLiveText(subscriber: Subscriber, sessionId: string, journal: AgentSessionJournal) {
    const items = this.hooks.readLiveText?.(sessionId) ?? []
    // Sending nothing leaves any waiting live text for after the subscriber catches up.
    const sends = items.length > 0 && liveText.subscriberAtHead(subscriber, journal)
    return sends && this.lanes.of(subscriber).sendsLiveText(items) ? items : []
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
    this.lanes.of(subscriber).ordered(deliver)
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
    this.lanes.clear(subscriber)
    const session = this.bySession.get(subscriber.sessionId)
    session?.delete(subscriber.id)
    this.shownViewers.unwatch(subscriber, session?.size === 0)
    if (session?.size === 0) {
      this.bySession.delete(subscriber.sessionId)
      this.forkMarkers.delete(subscriber)
    }
    this.promptSuggestions.reconcile(subscriber.sessionId)
  }
}
