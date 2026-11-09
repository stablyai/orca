import { AccountsSnapshotSchema, decodeAccountsSnapshot } from '../components/accounts-snapshot'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { hostQueryKey } from '../query/host-query-key'
import type { PersistedHostFamily } from '../query/host-query-persistence'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** Usage and rate limits are live facts: a stored snapshot keeps the accounts and drops every number. */
function withoutAccountUsage(snapshot: AccountsSnapshot | null): AccountsSnapshot | null {
  if (!snapshot) {
    return null
  }
  const { claudeTarget, codexTarget } = snapshot.rateLimits
  return {
    ...snapshot,
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget,
      codexTarget,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

/** A host's last `accounts.subscribe` snapshot; null when the desktop sent one this phone can't read. */
export const accountsSnapshotFamily: PersistedHostFamily<AccountsSnapshot | null> = {
  family: 'accounts.snapshot',
  persist: {
    version: 1,
    dataSchema: AccountsSnapshotSchema.nullable(),
    strip: withoutAccountUsage
  }
}

// Host-wide, read on the desktop itself; kept free of the host list's module, which the Accounts page doesn't load.
export const accountsSnapshotKey = (hostId: string) =>
  hostQueryKey(hostId, accountsSnapshotFamily.family, { exec: 'local' }, {})

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
