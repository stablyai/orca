import type { OrchestrationBusyDelivery } from '../../../../../../shared/orchestration-busy-delivery'
import type { SendRecipientWarning } from './recipient-routing'

/**
 * The relay between Orca servers does not carry `--delivery` yet, so the receiving server queues
 * the message. Said in the receipt rather than left to degrade silently.
 */
export function federatedSteerWarnings(
  delivery: OrchestrationBusyDelivery | undefined,
  recipient: string,
  /** How the message names the recipient, when the address alone would mislead. */
  described = recipient
): SendRecipientWarning[] {
  return delivery === 'steer'
    ? [
        {
          code: 'delivery_not_relayed',
          recipient,
          message: `--delivery steer is not applied on another Orca server; this message to ${described} will be queued.`
        }
      ]
    : []
}
