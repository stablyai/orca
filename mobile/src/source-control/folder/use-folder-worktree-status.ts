import { useEffect } from 'react'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import { useHostQuery } from '../../query/host-query'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import {
  gitStatusSummaryQuery,
  serverGitStatusSummaryQuery
} from '../changes/mobile-git-status-query'

const NO_INPUT = {}

/** One attached worktree's status summary, read on its own server when relayed. */
export function useFolderWorktreeStatus(args: {
  hostId: string
  /** The paired desktop's client while connected and the row can be read, else null. */
  client: RpcClient | null
  routeHost: ExecutionHostId | undefined
  worktreeId: string
  subscribed: boolean
  refreshers: Set<() => void>
}) {
  const { hostId, client, routeHost, worktreeId, subscribed, refreshers } = args
  const rowClient = client && routeHost ? scopeRpcClientToExecutionHost(client, routeHost) : client
  const status = useHostQuery(
    routeHost ? serverGitStatusSummaryQuery : gitStatusSummaryQuery,
    { hostId, client: rowClient },
    { exec: routeHost ?? 'local', worktree: worktreeId },
    NO_INPUT,
    { subscribed }
  )
  const refetch = status.refetch
  useEffect(() => {
    const refresh = () => void refetch()
    refreshers.add(refresh)
    return () => {
      refreshers.delete(refresh)
    }
  }, [refetch, refreshers])
  return status
}
