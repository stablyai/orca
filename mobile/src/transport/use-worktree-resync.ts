import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

export function useWorktreeResync(args: {
  client: RpcClient | null
  connState: ConnectionState
  fetchWorktrees: (opts?: { allowDuringModal?: boolean }) => Promise<void>
  fetchRepoMetadata: (options?: { force?: boolean; queueIfInFlight?: boolean }) => Promise<void>
}): { refreshing: boolean; onRefresh: () => Promise<void> } {
  const { client, connState, fetchWorktrees, fetchRepoMetadata } = args

  // Reconnect must refetch cached worktrees after background/sleep (#8498).
  const prevConnStateRef = useRef(connState)
  useEffect(() => {
    const prev = prevConnStateRef.current
    prevConnStateRef.current = connState
    if (prev !== 'connected' && connState === 'connected' && client) {
      void fetchWorktrees({ allowDuringModal: true })
    }
    // startHostWorktreeRefresh owns repo metadata refresh; reconnect here refetches worktrees only.
  }, [connState, client, fetchWorktrees])

  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    setRefreshing(true)
    try {
      await fetchWorktrees({ allowDuringModal: true })
      await fetchRepoMetadata({ force: true })
    } finally {
      setRefreshing(false)
    }
  }, [client, connState, fetchWorktrees, fetchRepoMetadata])

  return { refreshing, onRefresh }
}
