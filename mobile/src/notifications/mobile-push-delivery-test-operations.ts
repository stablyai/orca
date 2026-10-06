import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { pushDeliveryTestResultSchema } from './notification-reply-schema'

/**
 * The settings screen's "send a test notification" probe.
 *
 * A skip rather than a throw, because the screen walks its connected desktops and a `forbidden` or
 * `method_not_found` refusal means "try the next one" rather than "stop": the code decides that, so
 * the refusal stays at the call site. Separate from the registration sends, which keep this
 * device's push route current and have no screen to report on.
 */
export const pushDeliveryTest = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.test-push-or-skip',
    method: 'notifications.testPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-test-result', pushDeliveryTestResultSchema)
  })
)
