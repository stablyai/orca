import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { sessionProjectNameSchema } from './session-project-name-reply-schema'

export const sessionProjectNameRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.project-name-or-skip',
    method: 'repo.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('project-name', sessionProjectNameSchema)
  })
)
