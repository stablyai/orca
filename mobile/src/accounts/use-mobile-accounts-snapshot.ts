import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AccountsSnapshotError, decodeAccountsSnapshot } from '../components/accounts-snapshot'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  accountsSnapshotKey,
  accountsSnapshotOptions,
  subscribeAccountsSnapshots,
  withoutAccountUsage
} from './accounts-snapshot-stream'

/**
 * One host's accounts: the last stored snapshot at once, then the desktop's stream, or `accounts.list` when the
 * stream fails. Usage shows only from a read on the current connection; anything older shows accounts alone.
 */
export function useMobileAccountsSnapshot({
  hostId,
  client,
  connState,
  lastConnectedAt
}: {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  lastConnectedAt: number | null
}) {
  const t = useMobileTranslation()
  const queryClient = useQueryClient()
  const { data, dataUpdatedAt } = useQuery(accountsSnapshotOptions(hostId))
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const acceptSnapshot = useCallback(
    (nextSnapshot: AccountsSnapshot) => {
      queryClient.setQueryData(accountsSnapshotKey(hostId), nextSnapshot)
      setError(null)
    },
    [hostId, queryClient]
  )
  const rejectInvalidSnapshot = useCallback(() => {
    // Fail closed on unrecognized snapshot: stale data can expose finite reset for wrong account.
    queryClient.setQueryData(accountsSnapshotKey(hostId), null)
    setError(t('accounts.screen.invalidSnapshot', 'Invalid accounts snapshot from host'))
  }, [hostId, queryClient, t])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (e instanceof AccountsSnapshotError) {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

  // Stream desktop poll/account-switch updates, falling back to one-shot accounts.list on subscription error.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    return subscribeAccountsSnapshots(client, {
      onSnapshot: acceptSnapshot,
      onInvalidSnapshot: rejectInvalidSnapshot,
      onStreamError: () => void refresh()
    })
  }, [acceptSnapshot, client, connState, refresh, rejectInvalidSnapshot])

  // A stored snapshot, or one read before the latest connect, can't vouch for usage.
  const live =
    data != null &&
    connState === 'connected' &&
    lastConnectedAt !== null &&
    dataUpdatedAt >= lastConnectedAt
  const snapshot = useMemo(
    () => (live ? (data ?? null) : withoutAccountUsage(data ?? null)),
    [live, data]
  )

  return {
    snapshot,
    live,
    readAt: data != null ? dataUpdatedAt : null,
    error,
    refreshing,
    refresh,
    acceptSnapshot
  }
}
