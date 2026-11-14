import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { detectedAgentsSchema, refreshedAgentsSchema } from './mobile-agent-detection-reply-schema'

// Launch detection surfaces host refusals; advisory task-drawer readers intentionally skip them.
export const preflightDetectAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-agents',
    method: 'preflight.detectAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)

export const preflightRefreshAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.refresh-agents',
    method: 'preflight.refreshAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('refreshed-agents', refreshedAgentsSchema)
  })
)

export const preflightDetectRemoteAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)
