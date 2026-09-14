import { captureRpcOperationSettlement, defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'

const opaqueResultReader: RpcCompatibleReader<unknown, 'opaque-result', unknown> = (value) => ({
  compatible: true,
  variant: 'opaque-result',
  value,
  salvage: { droppedPaths: [], droppedCount: 0 }
})

export const mobileWorktreeCatalog = defineRpcOperation({
  name: 'mobile.worktree-catalog',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: opaqueResultReader
})

export const mobileWorktreeActivate = defineRpcOperation({
  name: 'mobile.worktree-activate',
  method: 'worktree.activate',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: opaqueResultReader
})

export { captureRpcOperationSettlement, runRpcOperation }
