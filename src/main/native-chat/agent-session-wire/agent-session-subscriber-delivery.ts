import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
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

export async function emitSubscriberDelivery(
  port: SubscriberDeliveryPort,
  ...args: Parameters<SubscriberDeliveryPort['emit']>
): Promise<boolean | void> {
  if (port.emitSteps) {
    return finishJournalStepsAsync(port.emitSteps(...args))
  }
  port.emit(...args)
}
