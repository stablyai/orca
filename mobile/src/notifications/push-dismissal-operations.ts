import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { missedNotificationsSchema } from './notification-reply-schema'

// Keep catch-up refusals nonthrowing: background reconciliation has no error screen and must leave banners for the next pass. Preserve nullish replies for the caller’s optional access.
export const pushMissedSinceRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.missed-since-or-skip',
    method: 'notifications.getMissedSince',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('missed-notifications', missedNotificationsSchema)
  })
)

export type MobilePushDismissalRpcSender = Parameters<typeof pushMissedSinceRead.request>[0]
