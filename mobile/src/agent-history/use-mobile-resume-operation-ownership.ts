import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export function useMobileResumeOperationOwnership(
  hostId: string,
  worktreeId: string,
  client: RpcClient | null,
  connection: ConnectionState
) {
  const generation = client?.getGeneration?.()
  const owner = useMemo(
    () => ({ hostId, worktreeId, client, connection, generation }),
    [hostId, worktreeId, client, connection, generation]
  )
  const currentOwner = useRef<typeof owner | null>(owner)
  useLayoutEffect(() => {
    currentOwner.current = owner
    return () => {
      currentOwner.current = null
    }
  }, [owner])
  return useCallback(
    () => () => {
      if (
        currentOwner.current !== owner ||
        owner.connection !== 'connected' ||
        !owner.client ||
        owner.client.getState() !== 'connected' ||
        owner.client.getGeneration?.() !== owner.generation
      ) {
        throw new Error('Host connection changed. Retry resume.')
      }
    },
    [owner]
  )
}
