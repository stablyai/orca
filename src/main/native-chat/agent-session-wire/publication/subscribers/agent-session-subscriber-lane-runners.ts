import {
  deliverToSubscriber,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import {
  publishSubscriberLiveText,
  republishSubscriberBackgroundTasks
} from './agent-session-live-publications'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'
import {
  SubscriberDeliveryLane,
  type SubscriberCatchUp,
  type SubscriberDeliveryLaneRunners,
  type SubscriberDeliveryRetention
} from './agent-session-subscriber-delivery-lane'
import { journalStatusReceiptProgress } from '../../../agent-session-journal/journal-status-receipt-progress'
import type { Subscriber } from './agent-session-subscribe-input'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'

type LaneOwner = {
  deliveryPort: () => SubscriberDeliveryPort
  now: () => number
  isActive: (subscriber: Subscriber) => boolean
  fail: (subscriber: Subscriber, error: unknown) => void
}

/** How one subscriber's lane runs each kind of waiting work. */
export function subscriberLaneRunners(
  subscriber: Subscriber,
  owner: LaneOwner
): SubscriberDeliveryLaneRunners {
  const { sessionId } = subscriber
  return {
    catchUp: ({ journal, port, hostNow, activity, receiptsOnly, queuePort }) =>
      deliverToSubscriber(port, {
        subscriber,
        journal,
        hostNow,
        emitCheckpoint: false,
        activity,
        receiptsOnly,
        queuePort
      }),
    backgroundTasks: (fence) =>
      republishSubscriberBackgroundTasks(
        owner.deliveryPort(),
        [subscriber],
        sessionId,
        fence,
        owner.now()
      ),
    liveText: ({ journal, fence, items, hostNow }) =>
      publishSubscriberLiveText(owner.deliveryPort(), {
        sessionId,
        journal,
        fence,
        items,
        subscribers: [subscriber],
        hostNow
      }),
    mergeCatchUp: mergeSubscriberCatchUp,
    runnable: () => owner.isActive(subscriber),
    failed: (error) => {
      if (!(error instanceof SubscriberFrameSuperseded)) {
        owner.fail(subscriber, error)
      }
    },
    now: owner.now
  }
}

/** The newer fan-out's reads are fresher; a text-only commit never hides an owed queue read. */
export function mergeSubscriberCatchUp(
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
    port: queueChanged === next.queueChanged ? next.port : next.queuePort(),
    queuePort: next.queuePort,
    queueChanged,
    receiptsOnly: pending.receiptsOnly && next.receiptsOnly,
    hostNow: next.hostNow,
    ...(activity !== undefined ? { activity } : {})
  }
}

/** Each subscriber's delivery lane, made on first use and cleared when the subscriber drops. */
export class SubscriberLanes {
  private readonly lanes = new WeakMap<Subscriber, SubscriberDeliveryLane>()

  constructor(private readonly owner: LaneOwner) {}

  catchUp(
    subscribers: Iterable<Subscriber>,
    next: SubscriberCatchUp,
    receiptsAfter?: AgentJournalCursor
  ): void {
    const progress = receiptsAfter && journalStatusReceiptProgress(next.journal)
    for (const subscriber of subscribers) {
      const catchUpOwed =
        receiptsAfter !== undefined &&
        (subscriber.cursor.epoch !== receiptsAfter.epoch ||
          subscriber.cursor.sequence < receiptsAfter.sequence)
      // A receipt may supersede a capture that still owes an earlier turn or queue change.
      if (receiptsAfter && !subscriber.readsProviderReceipts && !catchUpOwed) {
        continue
      }
      const receiptSuffix =
        progress &&
        subscriber.readsProviderReceipts &&
        subscriber.cursor.epoch === progress.epoch &&
        subscriber.cursor.sequence >= progress.after
      this.of(subscriber).catchUp(
        catchUpOwed && !next.queueChanged && !receiptSuffix
          ? { ...next, port: next.queuePort(), queueChanged: true }
          : { ...next, receiptsOnly: receiptsAfter !== undefined && !next.queueChanged }
      )
    }
  }

  of(subscriber: Subscriber): SubscriberDeliveryLane {
    let lane = this.lanes.get(subscriber)
    if (!lane) {
      lane = new SubscriberDeliveryLane(subscriberLaneRunners(subscriber, this.owner))
      this.lanes.set(subscriber, lane)
    }
    return lane
  }

  clear(subscriber: Subscriber): void {
    this.lanes.get(subscriber)?.clear()
  }

  /** Busy lanes of every live subscriber. */
  retention(
    bySession: ReadonlyMap<string, ReadonlyMap<string, Subscriber>>,
    now: number,
    counted: Set<object>
  ): SubscriberDeliveryRetention[] {
    const retained: SubscriberDeliveryRetention[] = []
    for (const session of bySession.values()) {
      for (const subscriber of session.values()) {
        const lane = this.lanes.get(subscriber)
        if (lane && !lane.idle) {
          retained.push(lane.retention(now, counted))
        }
      }
    }
    return retained
  }
}
