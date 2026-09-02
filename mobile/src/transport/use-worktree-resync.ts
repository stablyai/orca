import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// Why (#8498): extracted from HostScreen so the file stays under its
// max-lines budget. Handles the reconnect edge (refetch on transition into
// 'connected') and manual pull-to-refresh, neither of which the steady-state
// focus/embedded polls cover.
export function useWorktreeResync(args: {
  client: RpcClient | null
  connState: ConnectionState
  fetchWorktrees: (opts?: { allowDuringModal?: boolean }) => Promise<void>
  fetchRepoMetadata: (options?: { force?: boolean; queueIfInFlight?: boolean }) => Promise<void>
}): { refreshing: boolean; onRefresh: () => Promise<void> } {
  const { client, connState, fetchWorktrees, fetchRepoMetadata } = args

  // Why (#8498): socket-only reconnect left a stale cached snapshot after
  // background/sleep. Refetch on the transition INTO 'connected', not every poll tick.
  const prevConnStateRef = useRef(connState)
  useEffect(() => {
    const prev = prevConnStateRef.current
    prevConnStateRef.current = connState
    if (prev !== 'connected' && connState === 'connected' && client) {
      void fetchWorktrees({ allowDuringModal: true })
    }
    // Why: repo metadata refetch on reconnect is owned by startHostWorktreeRefresh (mount +
    // reposChanged + stream replay); this effect only refetches worktrees, so fetchRepoMetadata
    // is intentionally not a dependency here.
  }, [connState, client, fetchWorktrees])

  const [refreshing, setRefreshing] = useState(false)
  // Why (#8498): let the user force a fresh snapshot instead of the possibly-poisoned cache.
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
