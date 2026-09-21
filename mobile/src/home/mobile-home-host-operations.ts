import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { homeHostAccountsSchema, homeHostStatsSchema } from './home-host-reply-schema'

/**
 * The Home card's per-host counts. Decorative: a refused summary leaves the card on whatever it
 * already showed, so refusal is a skip, and the skip is what carries an unreadable summary to the
 * fetch's own `.catch` rather than seating it in the card's per-host slot. Its glab and Linear probes are the task-tooling reads in
 * ../tasks/mobile-task-runtime-operations.ts — the same question, asked by a second screen.
 */
export const homeHostStatsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'stats.home-summary-or-skip',
    method: 'stats.summary',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('home-stats-summary', homeHostStatsSchema)
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
    read: rpcResultVariant('home-accounts-snapshot', homeHostAccountsSchema)
  })
)
