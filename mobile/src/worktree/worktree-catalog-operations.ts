import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { retiredWorktreeNamesSchema, worktreeCatalogSchema } from './worktree-catalog-reply-schema'

// Both reads here are best-effort: a refused catalog leaves the last proven counts and the last
// confirmed rows in place rather than rendering a host as empty (STA-3123).

/**
 * worktree.ps. One family for all three readers — the Home card's summary, the host screen's
 * snapshot poll and the agent-history panel's `scopePaths` seed — because they ask the same
 * question with the same acceptance. The checked reader keeps the `unchanged` envelope readable —
 * the snapshot client admits one the card never sees — and the skip is what carries an absent or
 * null result to each caller's own failure path instead of to a property read on it.
 */
export const worktreeCatalogRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.catalog-or-skip',
    method: 'worktree.ps',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-catalog', worktreeCatalogSchema)
  })
)

/**
 * Names already spent in one repo. The payload is unchecked because the call site projects it
 * through `readRetiredNameRegistryForRepo`, which reads a refusal as an empty registry — the
 * behaviour a skip preserves, and not the same thing as the failure a rejection means here.
 */
export const retiredWorktreeNamesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.retired-names-or-skip',
    method: 'worktree.listRetiredNames',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('retired-names', retiredWorktreeNamesSchema)
  })
)
