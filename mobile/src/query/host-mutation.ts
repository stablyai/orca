import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { isRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import '../transport/connection/stable-logical-rpc-client'
import { isLogicalClientCutoverError } from '../transport/connection/logical-client-cutover-error'
import type { ConnectionState } from '../transport/connection/connection-state'
import { CUTOVER_RETRY_DELAY_MS, isHostNotConnectedError } from './host-query-errors'
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
    /** Undoes only this write from the entries snapshotted before `apply`; by default they are restored whole. */
    revert?: (queryClient: QueryClient, vars: TVars, snapshot: [QueryKey, unknown][]) => void
  }
  /** Writes what the host confirmed (e.g. a re-read slice) into the cache. */
  accept?: (queryClient: QueryClient, hostId: string, vars: TVars, result: TResult) => void
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

export type HostMutationCallOptions = {
  /** Routes the write elsewhere over the host's connection (e.g. a server row); null when that route is unreachable. */
  route?: (client: RpcClient) => RpcClient | null
  onPhase?: (phase: HostMutationPhase) => void
}

export type HostMutationContext = HostMutationCallOptions & {
  hostId: string
  queryClient: QueryClient
  /** The host's client now; a reconnect can replace it while a lost reply waits. */
  client: () => RpcClient | null
  /** Resolves once the host's current client is connected. */
  connected: () => Promise<void>
}

/** The write's route (e.g. a server row's owner) can't be reached through this host. */
export class HostRouteUnreachableError extends Error {
  constructor() {
    super('The workspace server is unreachable')
  }
}

// Why: errors crossing the page bridge are rebuilt as other classes, so also match by message.
export function isHostRouteUnreachableError(error: unknown): boolean {
  return (
    error instanceof HostRouteUnreachableError ||
    (error instanceof Error && error.message === 'The workspace server is unreachable')
  )
}

function isUnconfirmed(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}

// block and draft refuse at once while the host is down, instead of waiting in the transport for it.
function writeClient(context: HostMutationContext, failFast: boolean): RpcClient {
  const client = context.client()
  if (!client) {
    throw new Error(`Not connected: ${context.hostId}`)
  }
  const routed = context.route ? context.route(client) : client
  if (!routed) {
    throw new HostRouteUnreachableError()
  }
  return failFast ? hostReadClient(routed) : routed
}

async function applyOptimistic<TVars>(
  optimistic: NonNullable<HostMutation<TVars, unknown>['optimistic']>,
  { queryClient, hostId }: HostMutationContext,
  vars: TVars
): Promise<() => void> {
  const keys = optimistic.keys(hostId, vars)
  // Only entries with data are patched; cancelling a first load would leave it with nothing to restart it.
  const patched = (query: Query) => query.state.data !== undefined
  await Promise.all(
    keys.map((queryKey) => queryClient.cancelQueries({ queryKey, predicate: patched }))
  )
  const snapshot = keys.flatMap((queryKey) => queryClient.getQueriesData({ queryKey }))
  optimistic.apply(queryClient, hostId, vars)
  return () => {
    if (optimistic.revert) {
      optimistic.revert(queryClient, vars, snapshot)
      return
    }
    for (const [queryKey, data] of snapshot) {
      queryClient.setQueryData(queryKey, data)
    }
  }
}

function invalidate<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  context: HostMutationContext,
  vars: TVars
): void {
  for (const queryKey of mutation.invalidates?.(context.hostId, vars) ?? []) {
    void context.queryClient.invalidateQueries({ queryKey })
  }
}

// A lost reply never rolls back: the host may have applied it, so the write is re-checked once connected.
export async function runHostMutation<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  context: HostMutationContext,
  vars: TVars
): Promise<TResult> {
  const onPhase = context.onPhase ?? (() => {})
  onPhase('pending')
  try {
    const client = writeClient(context, mutation.offline !== 'queue')
    const rollback = mutation.optimistic
      ? await applyOptimistic(mutation.optimistic, context, vars)
      : null
    let result: TResult
    try {
      result = await mutation.send(client, vars)
    } catch (error) {
      if (!isUnconfirmed(error)) {
        rollback?.()
        throw error
      }
      onPhase('unconfirmed')
      result = await confirmOnceConnected(mutation, context, vars, rollback)
    }
    mutation.accept?.(context.queryClient, context.hostId, vars, result)
    invalidate(mutation, context, vars)
    return result
  } finally {
    onPhase('idle')
  }
}

async function confirmOnceConnected<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  context: HostMutationContext,
  vars: TVars,
  rollback: (() => void) | null
): Promise<TResult> {
  for (;;) {
    await context.connected()
    try {
      return await mutation.confirm(writeClient(context, true), vars)
    } catch (error) {
      if (!isUnconfirmed(error) && !isHostNotConnectedError(error)) {
        rollback?.()
        throw error
      }
      // A path switch under the check: try again shortly, as host reads do.
      if (isLogicalClientCutoverError(error)) {
        await new Promise((resolve) => setTimeout(resolve, CUTOVER_RETRY_DELAY_MS))
        continue
      }
      // Lost again with the host still up (e.g. it timed out): stop here and let the screen offer Retry.
      if (context.client()?.getState() === 'connected') {
        invalidate(mutation, context, vars)
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
  /** The action is off: the host is unreachable and this family does not queue. */
  blockedOffline: boolean
  mutate: (vars: TVars, options?: HostMutationCallOptions) => Promise<TResult>
}

type Waiter = { resolve: () => void; reject: (reason: Error) => void }

// Lives as long as the screen that owns the write, so a lost reply is still settled after its sheet closes.
export function useHostMutation<TVars, TResult>(
  mutation: HostMutation<TVars, TResult>,
  host: { hostId: string; client: RpcClient | null }
): HostMutationHandle<TVars, TResult> {
  const { hostId, client } = host
  const queryClient = useQueryClient()
  const state = useClientState(client)
  const calmState = useCalmConnectionState(state, client?.getLastConnectedAt() ?? null)
  // A write refused for being offline while the calm state still hid the drop.
  const [refusedOffline, setRefusedOffline] = useState(false)
  if (refusedOffline && state === 'connected') {
    setRefusedOffline(false)
  }
  // A reconnect (Retry, re-pair) can swap the client under a write waiting for its answer.
  const clientRef = useRef(client)
  const waitersRef = useRef(new Set<Waiter>())
  const mountedRef = useRef(true)
  useEffect(() => {
    clientRef.current = client
    if (state === 'connected' && client) {
      const waiters = [...waitersRef.current]
      waitersRef.current.clear()
      waiters.forEach((waiter) => waiter.resolve())
    }
  }, [client, state])
  useEffect(() => {
    mountedRef.current = true
    const waiters = waitersRef.current
    return () => {
      mountedRef.current = false
      waiters.forEach((waiter) => waiter.reject(new Error('Screen closed')))
      waiters.clear()
    }
  }, [])

  const blockedOffline =
    mutation.offline !== 'queue' &&
    (client === null || calmState !== 'connected' || (refusedOffline && state !== 'connected'))

  const mutate = useCallback(
    async (vars: TVars, options?: HostMutationCallOptions): Promise<TResult> => {
      const onPhase = options?.onPhase
      try {
        return await runHostMutation(
          mutation,
          {
            hostId,
            queryClient,
            client: () => clientRef.current,
            connected: () =>
              clientRef.current?.getState() === 'connected'
                ? Promise.resolve()
                : new Promise<void>((resolve, reject) =>
                    waitersRef.current.add({ resolve, reject })
                  ),
            route: options?.route,
            onPhase:
              onPhase &&
              ((phase) => {
                if (mountedRef.current) {
                  onPhase(phase)
                }
              })
          },
          vars
        )
      } catch (error) {
        if (isHostNotConnectedError(error) && mountedRef.current) {
          setRefusedOffline(true)
        }
        throw error
      }
    },
    [mutation, hostId, queryClient]
  )

  return { blockedOffline, mutate }
}
