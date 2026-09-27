import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { missedNotificationsSchema } from './notification-reply-schema'

/**
 * The catch-up read that tells this device which of the banners still in its OS tray the host has
 * already dismissed elsewhere.
 *
 * A skip rather than a throw: reconciliation is a background pass with no screen to raise a host
 * message on, and a refusal leaves the tray as it is for the next pass. The member read stays at
 * the call site, where the optional chaining over `dismissedPushes` tolerates a null result instead
 * of throwing on it.
 */
export const pushMissedSinceRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.missed-since-or-skip',
    method: 'notifications.getMissedSince',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('missed-notifications', missedNotificationsSchema)
  })
)

/** What the reconciliation sends with, named from the operation so no module names the raw port. */
export type MobilePushDismissalRpcSender = Parameters<typeof pushMissedSinceRead.request>[0]
