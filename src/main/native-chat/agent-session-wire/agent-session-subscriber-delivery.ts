import type { AgentSessionHistoryPage } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { withPublishedWork } from './agent-session-published-work'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { refreshPublishedWork } from './agent-session-work-refresh'
import {
  deliverToSubscriber,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'

type Delivery = Omit<Parameters<typeof deliverToSubscriber>[1], 'subscriber'>

/** One active catch-up and the latest pending publication keep each subscriber ordered. */
export function queueSubscriberDelivery(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  input: Delivery,
  initialDelivery: (delivery: Delivery) => void
): void {
  subscriber.pendingDelivery = {
    ...input,
    activity: input.activity !== undefined ? input.activity : subscriber.pendingDelivery?.activity,
    emitCheckpoint: input.emitCheckpoint || subscriber.pendingDelivery?.emitCheckpoint === true
  }
  if (subscriber.delivery) {
    return
  }
  subscriber.delivery = Promise.resolve()
    .then(async () => {
      while (subscriber.pendingDelivery && port.isActive(subscriber)) {
        const pending = subscriber.pendingDelivery
        subscriber.pendingDelivery = undefined
        await deliverToSubscriber(port, { subscriber, ...pending })
        if (pending.emitCheckpoint && port.isActive(subscriber)) {
          initialDelivery(pending)
        }
      }
    })
    .catch((error: unknown) => {
      console.warn('[agent-session-subscriber] catch-up failed', {
        sessionId: subscriber.sessionId,
        error
      })
    })
    .finally(() => {
      subscriber.delivery = undefined
      const pending = subscriber.pendingDelivery
      if (pending && port.isActive(subscriber)) {
        queueSubscriberDelivery(port, subscriber, pending, initialDelivery)
      }
    })
}

export function restateSessionSubscribers(
  port: SubscriberDeliveryPort,
  sessionId: string,
  subscribers: Iterable<Subscriber>,
  journal: AgentSessionJournal,
  fence: number,
  hostNow: number
): void {
  const view = journal.publicRead()
  const work = port.hooks.readCurrentWork?.(sessionId, journal)
  // Cache each stored/bounded form separately; each sizes its own page.
  let storedPage: AgentSessionHistoryPage | undefined
  let boundedPage: AgentSessionHistoryPage | undefined
  const read = (subscriber: Subscriber): AgentSessionHistoryPage =>
    withPublishedWork(
      readAgentSessionHydrationPage(
        journal,
        fence,
        subscriberHistoryReader(subscriber),
        view.currentSnapshot()
      ),
      work
    )
  const pageFor = (subscriber: Subscriber): AgentSessionHistoryPage =>
    subscriber.readHistorySnapshot
      ? read(subscriber)
      : subscriber.boundedFrames
        ? (boundedPage ??= read(subscriber))
        : (storedPage ??= read(subscriber))
  for (const subscriber of subscribers) {
    const page = pageFor(subscriber)
    port.emit(
      subscriber,
      {
        type: 'snapshot',
        sessionId,
        page,
        fence,
        hostNow,
        activity: port.activity(sessionId)
      },
      { currentWork: work, historyView: view.normalizationKey, journal }
    )
    subscriber.cursor = page.liveCursor ?? page.window.nextCursor
    subscriber.fence = fence
    refreshPublishedWork(port, subscriber, journal, work, { hostNow })
  }
}
