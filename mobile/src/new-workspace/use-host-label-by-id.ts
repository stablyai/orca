import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  HOST_LIST_TARGET,
  hostRepoLabelsQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/host-list-queries'
import { useHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const NO_HOST_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

// The host list's labels: the drawer shows the stored ones at once and the read refreshes them.
export function useHostLabelById(
  client: RpcClient | null,
  connected: boolean,
  hostId: string
): ReadonlyMap<ExecutionHostId, string> {
  const { data } = useHostQuery(
    hostRepoLabelsQuery,
    { hostId, client: connected ? client : null },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT
  )
  return useMemo(() => (data ? new Map(data.hostLabels) : NO_HOST_LABELS), [data])
}
