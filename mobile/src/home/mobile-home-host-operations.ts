import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * The Home card's per-host counts. Decorative: a refused summary leaves the card on whatever it
 * already showed, so refusal is a skip. Its glab and Linear probes are the task-tooling reads in
 * ../tasks/mobile-task-runtime-operations.ts — the same question, asked by a second screen.
 */
export const homeHostStatsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'stats.home-summary-or-skip',
    method: 'stats.summary',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('home-stats-summary')
  })
)

/**
 * The Home card's per-host accounts snapshot. Decorative like the counts above: a refused list
 * leaves the card on the snapshot it already holds, so refusal is a skip. The payload stays
 * unchecked because `decodeAccountsSnapshot` is what validates it, at the call site.
 */
export const homeHostAccountsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.home-snapshot-or-skip',
    method: 'accounts.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('home-accounts-snapshot')
  })
)
