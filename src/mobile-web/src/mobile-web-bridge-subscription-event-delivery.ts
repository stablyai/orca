import { tolerantMobileWebShellPayload } from '../../shared/mobile-web/shell-payload-tolerance'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebActiveSubscription } from './mobile-web-bridge-subscription-state'

/**
 * Sequence and schema are the only two things that can disqualify an event, and neither needs the
 * client's maps — so the client keeps the routing and this keeps the verdict.
 */
export function deliverMobileWebSubscriptionEvent(
  subscription: MobileWebActiveSubscription,
  message: { sequence: number; payload: unknown },
  fail: (error: MobileWebBridgeClientError) => void
): void {
  if (message.sequence < subscription.nextSequence) {
    return
  }
  if (message.sequence !== subscription.nextSequence) {
    fail(new MobileWebBridgeClientError('invalid_message', true))
    return
  }
  // The shell that authored this event can be a newer release than the page reading it, and a
  // schema failure here is permanent, so parse forgivingly in that direction only.
  const parsed = tolerantMobileWebShellPayload(subscription.eventSchema).safeParse(message.payload)
  if (!parsed.success) {
    fail(new MobileWebBridgeClientError('invalid_message', false))
    return
  }
  subscription.nextSequence += 1
  subscription.onEvent(parsed.data)
}
