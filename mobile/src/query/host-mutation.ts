import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useCalmConnectionState } from '../transport/calm-connection-state'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/types'
import { isHostNotConnectedError } from './host-query-errors'
import { hostReadClient } from './host-read-client'

/**
 * What a write does while its host is unreachable:
 * `block` and `draft` are off (a draft screen keeps the typed text); `queue` stays on and waits for the host.
 */
export type HostMutationOfflineMode = 'block' | 'draft' | 'queue'

export type HostMutation<TVars, TResult> = {
  offline: HostMutationOfflineMode
  /** Sends the write; throws the host's refusal. */
  send: (client: RpcClient, vars: TVars) => Promise<TResult>
  /** Settles a write whose reply was lost, once the host is back: resolves if the host has it, throws its refusal. */
  confirm: (client: RpcClient, vars: TVars) => Promise<TResult>
  optimistic?: {
    keys: (hostId: string, vars: TVars) => QueryKey[]
    apply: (queryClient: QueryClient, hostId: string, vars: TVars) => void
  }
  /** Only the slices the write changed. */
  invalidates?: (hostId: string, vars: TVars) => QueryKey[]
}

export function defineHostMutation<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>
): HostMutation<TVars, TResult> {
  return mutation
}

/** `unconfirmed`: sent, but the reply was lost; settles once the host is back. */
export type HostMutationPhase = 'idle' | 'pending' | 'unconfirmed'

type RunContext = {
  hostId: string
  client: RpcClient
  queryClient: QueryClient
  signal: AbortSignal
  onPhase: (phase: HostMutationPhase) => void
}

function isUnconfirmed(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}

function waitForConnected(client: RpcClient, signal: AbortSignal, freshEdge: boolean) {
  return new Promise<void>((resolve, reject) => {
    if (!freshEdge && client.getState() === 'connected') {
      resolve()
      return
    }
    let left = !freshEdge
    const stop = client.onStateChange((state) => {
      left ||= state !== 'connected'
      if (left && state === 'connected') {
        settle(resolve)
      }
    })
    const onAbort = () => settle(() => reject(signal.reason))
    function settle(done: () => void) {
      stop()
      signal.removeEventListener('abort', onAbort)
      done()
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort)
  })
}

async function applyOptimistic<TVars>(
  optimistic: NonNullable<HostMutation<TVars, unknown>['optimistic']>,
  { queryClient, hostId }: RunContext,
  vars: TVars
): Promise<() => void> {
  const keys = optimistic.keys(hostId, vars)
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })))
  const snapshot = keys.flatMap((queryKey) => queryClient.getQueriesData({ queryKey }))
  optimistic.apply(queryClient, hostId, vars)
  return () => {
    for (const [queryKey, data] of snapshot) {
      queryClient.setQueryData(queryKey, data)
    }
  }
}

// A lost reply never rolls back: the host may have applied it, so the write is re-checked once connected.
export async function runHostMutation<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  context: RunContext,
  vars: TVars
): Promise<TResult> {
  const { client, onPhase } = context
  // block and draft refuse at once while the host is down, instead of waiting in the transport for it.
  const sendClient = mutation.offline === 'queue' ? client : hostReadClient(client)
  onPhase('pending')
  const rollback = mutation.optimistic
    ? await applyOptimistic(mutation.optimistic, context, vars)
    : null
  try {
    let result: TResult
    try {
      result = await mutation.send(sendClient, vars)
    } catch (error) {
      if (!isUnconfirmed(error)) {
        rollback?.()
        throw error
      }
      onPhase('unconfirmed')
      result = await confirmOnceConnected(mutation, context, vars, rollback)
    }
    const keys = mutation.invalidates?.(context.hostId, vars) ?? []
    for (const queryKey of keys) {
      void context.queryClient.invalidateQueries({ queryKey })
    }
    return result
  } finally {
    onPhase('idle')
  }
}

async function confirmOnceConnected<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  { client, signal }: RunContext,
  vars: TVars,
  rollback: (() => void) | null
): Promise<TResult> {
  // After a failed check, wait for the next reconnect rather than retrying in a loop.
  for (let attempt = 0; ; attempt += 1) {
    await waitForConnected(client, signal, attempt > 0)
    try {
      return await mutation.confirm(hostReadClient(client), vars)
    } catch (error) {
      if (!isUnconfirmed(error) && !isHostNotConnectedError(error)) {
        rollback?.()
        throw error
      }
    }
  }
}

function useClientState(client: RpcClient | null): ConnectionState {
  const subscribe = useCallback(
    (onChange: () => void) => (client ? client.onStateChange(onChange) : () => {}),
    [client]
  )
  return useSyncExternalStore(subscribe, () => client?.getState() ?? 'disconnected')
}

export type HostMutationHandle<TVars, TResult> = {
  phase: HostMutationPhase
  /** The action is off: the host is unreachable and this family does not queue. */
  blockedOffline: boolean
  /** `sendClient` routes one write elsewhere (e.g. a server row) while the host's connection gates it. */
  mutate: (vars: TVars, sendClient?: RpcClient) => Promise<TResult>
}

// Lives as long as the screen that owns the write, so a lost reply is still settled after its sheet closes.
export function useHostMutation<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  host: { hostId: string; client: RpcClient | null }
): HostMutationHandle<TVars, TResult> {
  const { hostId, client } = host
  const queryClient = useQueryClient()
  const state = useClientState(client)
  const calmState = useCalmConnectionState(state, client?.getLastConnectedAt() ?? null)
  const [phase, setPhase] = useState<HostMutationPhase>('idle')
  // A write refused for being offline while the calm state still hid the drop.
  const [refusedOffline, setRefusedOffline] = useState(false)
  if (refusedOffline && state === 'connected') {
    setRefusedOffline(false)
  }
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    return () => controller.abort()
  }, [client])

  const blockedOffline =
    mutation.offline !== 'queue' &&
    (client === null || calmState !== 'connected' || (refusedOffline && state !== 'connected'))

  const mutate = useCallback(
    async (vars: TVars, sendClient?: RpcClient): Promise<TResult> => {
      const controller = abortRef.current
      if (!client || !controller) {
        throw new Error(`Not connected: ${hostId}`)
      }
      const signal = controller.signal
      try {
        return await runHostMutation(
          mutation,
          {
            hostId,
            client: sendClient ?? client,
            queryClient,
            signal,
            onPhase: (next) => {
              if (!signal.aborted) {
                setPhase(next)
              }
            }
          },
          vars
        )
      } catch (error) {
        if (isHostNotConnectedError(error) && !signal.aborted) {
          setRefusedOffline(true)
        }
        throw error
      }
    },
    [mutation, hostId, client, queryClient]
  )

  return { phase, blockedOffline, mutate }
}
