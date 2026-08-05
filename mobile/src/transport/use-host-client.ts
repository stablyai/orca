import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import { useRpcClientContext } from './rpc-client-react-context'
import type { ConnectionState } from './types'

export function useHostClient(hostId: string | undefined): {
  client: RpcClient | null
  state: ConnectionState
} {
  const context = useRpcClientContext()
  const [, force] = useState(0)
  const [state, setState] = useState<ConnectionState>(() =>
    hostId ? (context.getKnownState(hostId) ?? 'connecting') : 'disconnected'
  )
  const clientRef = useRef<RpcClient | null>(null)
  const clientHostIdRef = useRef<string | undefined>(hostId)

  useEffect(() => {
    if (!hostId) {
      clientRef.current = null
      clientHostIdRef.current = undefined
      setState('disconnected')
      return
    }
    clientHostIdRef.current = hostId
    let cancelled = false
    const unsubscribe = context.subscribeHostState(hostId, (next) => {
      if (cancelled) {
        return
      }
      setState(next)
      const found = context.getAllClients().find((entry) => entry.hostId === hostId)
      if (found && found.client !== clientRef.current) {
        clientRef.current = found.client
        force((value) => value + 1)
      } else if (!found && clientRef.current) {
        clientRef.current = null
        force((value) => value + 1)
      }
    })
    const initial = context.acquire(hostId)
    clientRef.current = initial
    setState(context.getKnownState(hostId) ?? 'connecting')
    if (initial) {
      force((value) => value + 1)
    }
    return () => {
      cancelled = true
      unsubscribe()
      context.release(hostId)
      clientRef.current = null
      clientHostIdRef.current = undefined
    }
  }, [context, hostId])

  const bound = clientHostIdRef.current === hostId
  const boundState = bound
    ? state
    : hostId
      ? (context.getKnownState(hostId) ?? 'connecting')
      : 'disconnected'
  return { client: bound ? clientRef.current : null, state: boundState }
}
