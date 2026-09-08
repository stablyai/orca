import { useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export type MobileWebBridgeRuntime = {
  client: RpcClient | null
  state: ConnectionState
  sessionId: string | undefined
}

export function useMobileWebBridgeRuntimeRef(
  client: RpcClient | null,
  state: ConnectionState,
  sessionId: string | undefined
): MutableRefObject<MobileWebBridgeRuntime> {
  const runtimeRef = useRef<MobileWebBridgeRuntime>({ client, state, sessionId })
  useEffect(() => {
    runtimeRef.current = { client, state, sessionId }
  }, [client, sessionId, state])
  return runtimeRef
}
