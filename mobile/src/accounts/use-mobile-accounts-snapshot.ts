import { useCallback, useEffect, useMemo, useState } from 'react'
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { AccountsSnapshotError, decodeAccountsSnapshot } from '../components/accounts-snapshot'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { holdsRestoredHostQueryData } from '../query/host-query-persistence'
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
  // Dated by when its read was sent, so a failure from an earlier connection doesn't outlive it.
  const [failure, setFailure] = useState<{ message: string; at: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Dated by when the read was sent: a reply from before the latest connect lands but never counts as live.
  const acceptSnapshot = useCallback(
    (nextSnapshot: AccountsSnapshot, readAt = Date.now()) => {
      const key = accountsSnapshotKey(hostId)
      if ((queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) <= readAt) {
        queryClient.setQueryData(key, nextSnapshot, { updatedAt: readAt })
      }
      setFailure(null)
    },
    [hostId, queryClient]
  )
  const rejectInvalidSnapshot = useCallback(
    (readAt = Date.now()) => {
      // Fail closed on unrecognized snapshot: stale data can expose finite reset for wrong account.
      queryClient.setQueryData(accountsSnapshotKey(hostId), null)
      setFailure({
        message: t('accounts.screen.invalidSnapshot', 'Invalid accounts snapshot from host'),
        at: readAt
      })
    },
    [hostId, queryClient, t]
  )

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    const sentAt = Date.now()
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result), sentAt)
      } else {
        setFailure({ message: res.error.message, at: sentAt })
      }
    } catch (e) {
      if (e instanceof AccountsSnapshotError) {
        rejectInvalidSnapshot(sentAt)
      } else {
        setFailure({ message: e instanceof Error ? e.message : String(e), at: sentAt })
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
      onSnapshot: (nextSnapshot) => acceptSnapshot(nextSnapshot),
      onInvalidSnapshot: () => rejectInvalidSnapshot(),
      onStreamError: () => void refresh()
    })
  }, [acceptSnapshot, client, connState, refresh, rejectInvalidSnapshot])

  // A stored snapshot, or one read before the latest connect, can't vouch for usage. Stored data can postdate the
  // connect: native Home writes it from its own stream.
  const live =
    data != null &&
    !holdsRestoredHostQueryData(queryClient, hashKey(accountsSnapshotKey(hostId))) &&
    connState === 'connected' &&
    lastConnectedAt !== null &&
    dataUpdatedAt >= lastConnectedAt
  const snapshot = useMemo(
    () => (live ? (data ?? null) : withoutAccountUsage(data ?? null)),
    [live, data]
  )

  const error =
    failure && (lastConnectedAt === null || failure.at >= lastConnectedAt) ? failure.message : null

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
