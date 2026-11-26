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
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { rememberLatestPerSession } from './structured-agent-session-activity-retention'
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
    readLiveText: (id) => this.hooks.readLiveText?.(id) ?? [],
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
    const { journal, attachProviderReceipts, ...fields } = input
    const session = this.bySession.get(input.sessionId) ?? new Map<string, Subscriber>()
    const replaced = session.get(input.id)
    const receipts = attachProviderReceipts?.(() => journal.cursor())
    if (replaced) {
      replaced.closeProviderReceipts?.()
      this.lanes.clear(replaced)
    }
    const liveCursor = journal.cursor()
    const subscriber: Subscriber = {
      ...fields,
      openProviderReceipts: receipts?.reachedHead,
      closeProviderReceipts: receipts?.close,
      readForkMarker: () => this.hooks.readForkMarker?.(fields.sessionId),
      cursor: input.cursor ?? { epoch: liveCursor.epoch, sequence: 0 },
      boundedFrames: input.boundedFrames === true,
      readsCurrentRequests: input.readsCurrentRequests === true,
      snapshotCatchUp: input.snapshotCatchUp !== false
    }
    subscriber.stopped = this.lanes.of(subscriber).stopped
    session.set(input.id, subscriber)
    this.bySession.set(input.sessionId, session)

    this.forkMarkers.add(subscriber)
    this.lanes.open(subscriber, journal, input.cursor !== undefined, {
      port: () => this.deliveryPort(input.sessionId, journal),
      refreshForkMarkers: () => this.forkMarkers.refresh(subscriber, journal, true)
    })
    this.promptSuggestions.opened(subscriber)
    const { sessionId, id } = subscriber
    return () => {
      // An asynchronous local receipt subscription can finish after its replacement opens.
      // Its disposer owns only that registration. Preserve the legacy stream cleanup semantics.
      if (!attachProviderReceipts || this.isActive(subscriber)) {
        this.close(sessionId, id)
      }
    }
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
    items: readonly AgentJournalRenderItem[],
    targets = this.subscribers(sessionId)
  ): void => {
    const hostNow = this.now()
    for (const subscriber of targets) {
      // Checked per subscriber, in case ending one ends another mid fan-out.
      if (this.isActive(subscriber)) {
        this.lanes.of(subscriber).liveText({ journal, fence, items, hostNow })
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
      this.lanes.snapshot(subscriber, journal, port, fence, hostNow)
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
    subscriber.closeProviderReceipts?.()
    this.lanes.clear(subscriber)
    const session = this.bySession.get(subscriber.sessionId)
    session?.delete(subscriber.id)
    if (session?.size === 0) {
      this.bySession.delete(subscriber.sessionId)
      this.forkMarkers.delete(subscriber)
    }
    this.promptSuggestions.reconcile(subscriber.sessionId)
  }
}
