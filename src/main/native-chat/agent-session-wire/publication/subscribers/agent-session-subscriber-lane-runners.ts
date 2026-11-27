import { resumeSubscriber } from './agent-session-stop-note-refresh'
import {
  deliverToSubscriber,
  publishSubscriberSnapshot,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import { republishSubscriberBackgroundTasks } from './agent-session-live-publications'
import { publishSubscriberLiveText, subscriberAtHead } from './agent-session-subscriber-live-text'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'
import {
  SubscriberDeliveryLane,
  type SubscriberCatchUp,
  type SubscriberDeliveryLaneRunners,
  type SubscriberDeliveryRetention
} from './agent-session-subscriber-delivery-lane'
import type { Subscriber } from './agent-session-subscribe-input'

type LaneOwner = {
  deliveryPort: () => SubscriberDeliveryPort
  now: () => number
  sendLiveTail: (subscriber: Subscriber, journal: SubscriberCatchUp['journal'], fence: number) => Promise<void>
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
    catchUp: async ({ journal, port, hostNow, activity }) => {
      const captured = await deliverToSubscriber(port, {
        subscriber,
        journal,
        hostNow,
        emitCheckpoint: false,
        activity
      })
      if (captured) {
        openProviderReceiptsAtHead(subscriber, journal)
      }
    },
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
    hostNow: next.hostNow,
    ...(activity !== undefined ? { activity } : {})
  }
}

/** Each subscriber's delivery lane, made on first use and cleared when the subscriber drops. */
export class SubscriberLanes {
  private readonly lanes = new WeakMap<Subscriber, SubscriberDeliveryLane>()

  constructor(private readonly owner: LaneOwner) {}

  open(
    subscriber: Subscriber,
    journal: SubscriberCatchUp['journal'],
    resume: boolean,
    input: { port: () => SubscriberDeliveryPort; refreshForkMarkers: () => Promise<void> }
  ): void {
    this.of(subscriber).ordered(async () => {
      const hostNow = this.owner.now()
      const port = input.port()
      const fence = subscriber.fence
      const caughtUp = resume
        ? await resumeSubscriber(port, subscriber, journal, hostNow, input.refreshForkMarkers)
        : (await publishSubscriberSnapshot(port, subscriber, journal, fence, hostNow)) !== undefined
      if (!resume) {
        subscriber.forkMarkerView = JSON.stringify(subscriber.readForkMarker?.())
      }
      await this.finishOpening(subscriber, journal, fence, caughtUp)
    })
  }

  snapshot(
    subscriber: Subscriber,
    journal: SubscriberCatchUp['journal'],
    port: SubscriberDeliveryPort,
    fence: number,
    hostNow: number
  ): void {
    this.of(subscriber).ordered(async () => {
      const caughtUp =
        (await publishSubscriberSnapshot(port, subscriber, journal, fence, hostNow)) !== undefined
      await this.finishOpening(subscriber, journal, fence, caughtUp)
    })
  }

  private async finishOpening(
    subscriber: Subscriber,
    journal: SubscriberCatchUp['journal'],
    fence: number,
    caughtUp: boolean
  ): Promise<void> {
    await this.owner.sendLiveTail(subscriber, journal, fence)
    if (caughtUp) {
      openProviderReceiptsAtHead(subscriber, journal)
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

function openProviderReceiptsAtHead(
  subscriber: Subscriber,
  journal: SubscriberCatchUp['journal']
): void {
  if (
    subscriber.openProviderReceipts &&
    subscriber.owedSnapshotFence === undefined &&
    subscriberAtHead(subscriber, journal)
  ) {
    subscriber.openProviderReceipts()
  }
}
