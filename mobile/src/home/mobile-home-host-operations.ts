import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { homeHostAccountsSchema, homeHostStatsSchema } from './home-host-reply-schema'

// Decorative counts skip refusals to retain the displayed snapshot; accepted unreadable rows decode as absent to preserve the host slot. Reuse Tasks operations for glab/Linear probes.
export const homeHostStatsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'stats.home-summary-or-skip',
    method: 'stats.summary',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('home-stats-summary', homeHostStatsSchema)
  })
)

// Skip refused accounts to retain the snapshot; decodeAccountsSnapshot validates the forwarded payload at the call site.
export const homeHostAccountsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.home-snapshot-or-skip',
    method: 'accounts.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('home-accounts-snapshot', homeHostAccountsSchema)
  })
)
