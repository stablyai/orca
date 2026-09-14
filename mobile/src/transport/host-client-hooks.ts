import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, HostProfile } from './types'
import type { HostClientAcquisition } from './host-client-acquisition-registry'
import { useRpcClientContext } from './client-context'

// Primary hook for screens: acquires the shared client on mount, releases on unmount, re-renders on state change.
export function useHostClient(hostId: string | undefined): {
  client: RpcClient | null
  clientId: string | null
  state: ConnectionState
} {
  const ctx = useRpcClientContext()
  const [, force] = useState(0)
  const [state, setState] = useState<ConnectionState>(() =>
    hostId ? (ctx.getKnownState(hostId) ?? 'connecting') : 'disconnected'
  )
  const clientRef = useRef<RpcClient | null>(null)
  const clientHostIdRef = useRef<string | undefined>(hostId)
  const acquisitionRef = useRef<HostClientAcquisition>({})

  useEffect(() => {
    if (!hostId) {
      clientRef.current = null
      clientHostIdRef.current = undefined
      setState('disconnected')
      return
    }
    clientHostIdRef.current = hostId
    let cancelled = false
    const unsub = ctx.subscribeHostState(hostId, (next) => {
      if (cancelled) {
        return
      }
      setState(next)
      const found = ctx.getAllClients().find((entry) => entry.hostId === hostId)
      if (found && found.client !== clientRef.current) {
        clientRef.current = found.client
        force((n) => n + 1)
      } else if (!found && clientRef.current) {
        clientRef.current = null
        force((n) => n + 1)
      }
    })
    const initial = ctx.acquire(hostId, acquisitionRef.current)
    clientRef.current = initial
    setState(ctx.getKnownState(hostId) ?? 'connecting')
    if (initial) {
      force((n) => n + 1)
    }
    return () => {
      cancelled = true
      unsub()
      ctx.release(hostId, acquisitionRef.current)
      clientRef.current = null
      clientHostIdRef.current = undefined
    }
  }, [ctx, hostId])

  const bound = clientHostIdRef.current === hostId
  const boundClient = bound ? clientRef.current : null
  const boundState = bound
    ? state
    : hostId
      ? (ctx.getKnownState(hostId) ?? 'connecting')
      : 'disconnected'
  return {
    client: boundClient,
    clientId: boundClient && hostId ? ctx.getClientId(hostId) : null,
    state: boundState
  }
}

export function useRefreshHostClient(): (hostId: string) => void {
  return useRpcClientContext().refreshHostClient
}

export function useForgetHostClient(): (hostId: string) => void {
  return useRpcClientContext().forgetHostClient
}

export function useDisconnectHostClient(): (hostId: string) => void {
  return useRpcClientContext().disconnectHostClient
}

export function useForceReconnect(): (hostId: string) => Promise<void> {
  return useRpcClientContext().forceReconnect
}

export function usePrimeHosts(): (hosts: HostProfile[]) => void {
  return useRpcClientContext().primeHosts
}
