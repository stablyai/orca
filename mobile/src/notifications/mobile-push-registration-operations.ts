import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  notificationUnreadReplySchema,
  pushRouteRegistrationSchema
} from './notification-reply-schema'

// Skip reconciliation refusals under catch(() => null): preserve stored route state until retry, with no screen requiring a host error.

export const pushRouteRegister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.register-push-or-skip',
    method: 'notifications.registerPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-registration', pushRouteRegistrationSchema)
  })
)

export const pushRouteUnregister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unregister-push-or-skip',
    method: 'notifications.unregisterPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-unregistered', notificationUnreadReplySchema)
  })
)
