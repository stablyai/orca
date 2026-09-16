import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// The two sends that keep this device's push route on a host current.
//
// Both are skips rather than throws: each runs under `catch(() => null)` inside a reconciliation
// chain whose answer is only ever "did this land", and a refusal means the stored records stay as
// they are until the next reconcile. Neither has a screen to show a host message on.

export const pushRouteRegister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.register-push-or-skip',
    method: 'notifications.registerPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('push-registration')
  })
)

/** The reply body is unread: a fulfilled unregister is the whole answer. */
export const pushRouteUnregister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unregister-push-or-skip',
    method: 'notifications.unregisterPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('push-unregistered')
  })
)
