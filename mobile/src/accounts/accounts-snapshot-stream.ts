import { decodeAccountsSnapshot } from '../components/accounts-snapshot'
import type { AccountsSnapshot } from '../components/AccountUsage'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** The desktop's `accounts.subscribe` stream, decoded: rate-limit polls and account switches as they happen. */
export function subscribeAccountsSnapshots(
  client: RpcClient,
  handlers: {
    onSnapshot: (snapshot: AccountsSnapshot) => void
    onInvalidSnapshot: () => void
    onStreamError: () => void
  }
): () => void {
  return client.subscribe('accounts.subscribe', null, (payload) => {
    if (!payload || typeof payload !== 'object' || !('type' in payload)) {
      return
    }
    if (payload.type === 'error') {
      handlers.onStreamError()
      return
    }
    if (payload.type !== 'ready' && payload.type !== 'snapshot') {
      return
    }
    let snapshot: AccountsSnapshot
    try {
      snapshot = decodeAccountsSnapshot('snapshot' in payload ? payload.snapshot : undefined)
    } catch {
      handlers.onInvalidSnapshot()
      return
    }
    handlers.onSnapshot(snapshot)
  })
}
