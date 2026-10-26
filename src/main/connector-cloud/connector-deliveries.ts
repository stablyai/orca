// Each cloud delivery mapped onto the existing connector seam call.
import {
  CONNECTOR_CLIENT_LIMITS,
  ConnectorDelivery,
  ConnectorDeliveryId,
  type ConnectorDeliveryResult
} from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import type { Delivery } from '../external-conversations/external-conversation-types'
import { placeLaunchTarget } from './connector-places'

export type DispatchedDelivery = {
  deliveryId: string
  /** False when this Orca refused it without calling the seam; only done is sent then. */
  received: boolean
  done: Promise<ConnectorDeliveryResult>
}

/** A thrown seam call (e.g. a conversation that no longer exists) is a refusal, not a lost delivery. */
function settle(call: () => Promise<Delivery>): Promise<ConnectorDeliveryResult> {
  let running: Promise<Delivery>
  try {
    running = call()
  } catch (error) {
    running = Promise.reject(error)
  }
  return running.catch((error: unknown): ConnectorDeliveryResult => ({
    outcome: 'refused',
    reason: error instanceof Error && error.message ? error.message : 'failed'
  }))
}

/**
 * Calls the seam synchronously, so its receipt exists before `received` is sent.
 * `msLeft` is what remains of the delivery's deadline, measured from when the poll was sent.
 */
export function dispatchDelivery(
  seam: ExternalConversationSeam,
  host: ExternalConversationHost,
  raw: unknown,
  msLeft: (expiresAt: number) => number
): DispatchedDelivery | null {
  const parsed = ConnectorDelivery.safeParse(raw)
  if (!parsed.success) {
    const id = ConnectorDeliveryId.safeParse(raw)
    return id.success ? refuse(id.data.deliveryId, { outcome: 'unsupported' }) : null
  }
  const delivery = parsed.data
  const { deliveryId, conversation: key } = delivery
  if (msLeft(delivery.expiresAt) < CONNECTOR_CLIENT_LIMITS.minDeadlineLeftMs) {
    return refuse(deliveryId, { outcome: 'expired' })
  }
  let done: Promise<ConnectorDeliveryResult>
  switch (delivery.kind) {
    case 'start': {
      const target = placeLaunchTarget(delivery.placeId, deliveryId)
      if (!target) {
        return refuse(deliveryId, { outcome: 'unsupported' })
      }
      const { agent, prompt } = delivery
      done = settle(
        async () => (await seam.start(host, key, deliveryId, { agent, target, prompt })).initial
      )
      break
    }
    case 'send':
      done = settle(() => seam.send(host, key, deliveryId, delivery.text))
      break
    case 'answer':
      done = settle(() => seam.answer(host, key, delivery.promptId, delivery.optionId))
      break
    case 'cancel':
      done = settle(() => seam.cancel(host, key, deliveryId))
      break
  }
  return { deliveryId, received: true, done }
}

function refuse(deliveryId: string, result: ConnectorDeliveryResult): DispatchedDelivery {
  return { deliveryId, received: false, done: Promise.resolve(result) }
}
