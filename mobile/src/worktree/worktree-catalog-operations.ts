import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { retiredWorktreeNamesSchema, worktreeCatalogSchema } from './worktree-catalog-reply-schema'

// Catalog refusal preserves proven counts/rows (STA-3123); retired-name refusal instead reads as an empty registry.

// Share acceptance across catalog consumers; admit unchanged replies and route null results to caller failure handling.
export const worktreeCatalogRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.catalog-or-skip',
    method: 'worktree.ps',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-catalog', worktreeCatalogSchema)
  })
)

// Forward retired-name replies to the per-repo validator; refusal yields an empty registry while transport rejection remains failure.
export const retiredWorktreeNamesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.retired-names-or-skip',
    method: 'worktree.listRetiredNames',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('retired-names', retiredWorktreeNamesSchema)
  })
)
