import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  multiRepoDeleteInspectionSchema,
  multiRepoDeleteResultSchema,
  multiRepoRetryReplySchema,
  multiRepoSiblingListSchema
} from './multi-repo-workspace-reply-schema'

export const multiRepoRetryMember = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'multiRepoWorkspace.retry-member',
    method: 'multiRepoWorkspace.retryMember',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('multi-repo-retry', multiRepoRetryReplySchema)
  })
)

export const multiRepoInspectDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'multiRepoWorkspace.inspect-delete',
    method: 'multiRepoWorkspace.inspectDelete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('multi-repo-delete-inspection', multiRepoDeleteInspectionSchema)
  })
)

export const multiRepoDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'multiRepoWorkspace.delete',
    method: 'multiRepoWorkspace.delete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('multi-repo-delete-result', multiRepoDeleteResultSchema)
  })
)

export const multiRepoSiblingListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'folderWorkspace.multi-repo-siblings-or-skip',
    method: 'folderWorkspace.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('multi-repo-siblings', multiRepoSiblingListSchema)
  })
)
