import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { pushDeliveryTestResultSchema } from './notification-reply-schema'

// Keep refusals at the probe caller: forbidden/method_not_found should try the next connected desktop, not stop the settings test.
export const pushDeliveryTest = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.test-push-or-skip',
    method: 'notifications.testPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-test-result', pushDeliveryTestResultSchema)
  })
)
