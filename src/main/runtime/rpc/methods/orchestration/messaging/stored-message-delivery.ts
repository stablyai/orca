import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationPartyIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { withDeliveryHoldWarning, unknownStoredDelivery } from './send-delivery-hold'

export async function observeStoredSend(
  runtime: OrcaRuntimeService,
  receipt: unknown,
  caller?: OrchestrationPartyIdentity
): Promise<unknown> {
  if (!receipt || typeof receipt !== 'object') {
    return receipt
  }
  const messages =
    'messages' in receipt && Array.isArray(receipt.messages)
      ? receipt.messages
      : 'message' in receipt
        ? [receipt.message]
        : []
  const outcomes = await Promise.all(
    messages.map(async (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        typeof message.id !== 'string' ||
        typeof message.to_handle !== 'string'
      ) {
        return null
      }
      const saved = Object.fromEntries(
        Object.entries(receipt).filter(
          ([key]) =>
            ![
              'state',
              'delivered',
              'deliveryMessage',
              'deliveryHint',
              'reason',
              'failureId',
              'target',
              'waiting',
              'individuallyHeld',
              'resetsAt',
              'recoveryUsed',
              'workerName',
              'provider',
              'runtimeFence',
              'deliveries'
            ].includes(key)
        )
      )
      const sent = 'messages' in receipt ? { message } : { ...saved, message }
      return runtime
        .getOrchestrationDb()
        .getFederatedDispatch(message.to_handle.replace(/^dispatch:/, ''))
        ? unknownStoredDelivery(sent, message.to_handle)
        : withDeliveryHoldWarning(
            sent,
            runtime,
            runtime.getOrchestrationDb(),
            message.to_handle,
            caller
          )
    })
  )
  const deliveries = outcomes.filter((value) => value !== null)
  if (deliveries.length === 1 && !('messages' in receipt)) {
    return deliveries[0]
  }
  if (!deliveries.length) {
    return receipt
  }
  const states = deliveries.map((value) => ('state' in value ? value.state : 'unknown'))
  const state = states.includes('held')
    ? 'held'
    : states.includes('unknown')
      ? 'unknown'
      : states.includes('queued')
        ? 'queued'
        : 'delivered'
  return {
    ...receipt,
    deliveries,
    delivered: state === 'delivered',
    state,
    deliveryMessage: deliveries
      .map((value) =>
        'deliveryMessage' in value
          ? value.deliveryMessage
          : 'Message kept. Delivery is unconfirmed.'
      )
      .join('\n')
  }
}
