import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

export const resolveLiveActivitySession = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.resolve-live-activity-session-or-skip',
    method: 'notifications.resolveLiveActivitySession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'live-activity-session',
      z.object({
        target: z
          .object({ worktreeId: z.string().min(1).max(2048), paneKey: z.string().min(1).max(2048) })
          .nullable()
      })
    )
  })
)

export const registerLiveActivity = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.register-live-activity-or-skip',
    method: 'notifications.registerLiveActivity',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('live-activity-registration', z.object({ registered: z.boolean() }))
  })
)

export const unregisterLiveActivity = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unregister-live-activity-or-skip',
    method: 'notifications.unregisterLiveActivity',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('live-activity-removal', z.object({ unregistered: z.boolean() }))
  })
)
