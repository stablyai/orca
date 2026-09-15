import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// The two workspace-catalog reads, both best-effort: a refused catalog leaves the last proven
// counts and the last confirmed rows in place rather than rendering a host as empty (STA-3123).

/**
 * worktree.ps. One family for both readers — the Home card's summary and the host screen's
 * snapshot poll — because they ask the same question with the same acceptance. The payload stays
 * unchecked: the snapshot client admits an `unchanged` envelope the card never sees.
 */
export const worktreeCatalogRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.catalog-or-skip',
    method: 'worktree.ps',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('worktree-catalog')
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
    read: rpcUncheckedPayloadReader('retired-names')
  })
)
