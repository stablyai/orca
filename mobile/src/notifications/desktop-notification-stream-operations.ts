import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * Closing the desktop notification stream on the host.
 *
 * Its own module rather than a line in `mobile-push-registration-operations.ts`: that module is the
 * push route this device holds with a gateway, and this is the socket subscription the paired
 * connection holds. They are two different deliveries of the same alert and neither implies the
 * other.
 *
 * A skip rather than a throw, and the reply is unread either way: the disposer sends this on its
 * way out with nothing left to show a host message on, and main's `.catch(() => {})` already made a
 * refusal and a dropped connection the same non-event.
 */
export const desktopNotificationStreamUnsubscribe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unsubscribe-or-skip',
    method: 'notifications.unsubscribe',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('notification-stream-closed')
  })
)
