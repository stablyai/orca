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
