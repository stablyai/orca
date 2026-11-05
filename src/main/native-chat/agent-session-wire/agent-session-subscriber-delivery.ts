import { emitCaughtUp } from './agent-session-subscriber-checkpoint'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'
import { journalDerivedRefreshPending } from '../agent-session-journal/journal-derived-read'
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
  initialDelivery: (delivery: Delivery) => void | Promise<void>
): void {
  if (
    !subscriber.delivery &&
    !journalDerivedRefreshPending(input.journal) &&
    sameJournalCursor(subscriber.cursor, input.journal.cursor()) &&
    (subscriber.snapshotCatchUp === false ||
      !subscriber.readsCurrentRequests ||
      input.journal.publicRead().normalizationKey === '' ||
      subscriber.historyView === input.journal.publicRead().normalizationKey)
  ) {
    emitCaughtUp(
      port,
      subscriber,
      input.emitCheckpoint,
      {
        hostNow: input.hostNow,
        ...(input.activity !== undefined ? { activity: input.activity } : {})
      },
      {
        journal: input.journal,
        work: port.hooks.readCurrentWork?.(subscriber.sessionId, input.journal)
      }
    )
    return
  }
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
          await initialDelivery(pending)
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

/** Retire a journal only after its final queued frames have reached current subscribers. */
export async function flushSubscriberDeliveries(read: () => readonly Subscriber[]): Promise<void> {
  for (;;) {
    const pending = read().flatMap((subscriber) =>
      subscriber.delivery ? [subscriber.delivery] : []
    )
    if (!pending.length) {
      return
    }
    await Promise.all(pending)
  }
}
