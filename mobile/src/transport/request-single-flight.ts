import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

type Deferred = {
  promise: Promise<RpcResponse>
  resolve: (value: RpcResponse) => void
  reject: (reason?: unknown) => void
}

type SingleFlightEntry = {
  // The request currently on the wire for this (client, host, kind).
  current: Promise<RpcResponse>
  // At most one trailing follow-up: every trigger that arrives while `current` is in flight coalesces
  // here so a refresh requested mid-read still re-reads the latest state (latest params win) instead of
  // being silently answered by the older in-flight response.
  followUp: { deferred: Deferred; params: unknown } | null
}

const inFlightRequests = new WeakMap<RpcClient, Map<string, Map<string, SingleFlightEntry>>>()

function makeDeferred(): Deferred {
  let resolve!: (value: RpcResponse) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function sendSingleFlightRequest(
  client: RpcClient,
  hostId: string,
  requestKind: string,
  params?: unknown
): Promise<RpcResponse> {
  let requestsByHost = inFlightRequests.get(client)
  if (!requestsByHost) {
    requestsByHost = new Map()
    inFlightRequests.set(client, requestsByHost)
  }
  let requestsByKind = requestsByHost.get(hostId)
  if (!requestsByKind) {
    requestsByKind = new Map()
    requestsByHost.set(hostId, requestsByKind)
  }

  const send = (): Promise<RpcResponse> => {
    try {
      return client.sendRequest(requestKind, params)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const existing = requestsByKind.get(requestKind)
  if (existing) {
    // A read is already on the wire: don't fire a duplicate now, but don't drop this trigger either.
    // Record (or refresh) a single trailing follow-up that runs once the current read settles.
    if (existing.followUp) {
      existing.followUp.params = params
    } else {
      existing.followUp = { deferred: makeDeferred(), params }
    }
    return existing.followUp.deferred.promise
  }

  const entry: SingleFlightEntry = { current: send(), followUp: null }
  requestsByKind.set(requestKind, entry)

  const cleanup = (): void => {
    if (requestsByKind.get(requestKind) !== entry) {
      return
    }
    requestsByKind.delete(requestKind)
    if (requestsByKind.size === 0) {
      requestsByHost.delete(hostId)
    }
    if (requestsByHost.size === 0) {
      inFlightRequests.delete(client)
    }
  }

  // Chain each settled request into either its queued follow-up (delivering the fresh result to every
  // caller that awaited it) or entry teardown. Recurses so triggers arriving during a follow-up queue
  // the next one.
  const onSettled = (): void => {
    const followUp = entry.followUp
    if (!followUp) {
      cleanup()
      return
    }
    entry.followUp = null
    let next: Promise<RpcResponse>
    try {
      next = client.sendRequest(requestKind, followUp.params)
    } catch (error) {
      next = Promise.reject(error)
    }
    entry.current = next
    next.then(
      (response) => followUp.deferred.resolve(response),
      (error) => followUp.deferred.reject(error)
    )
    void next.then(onSettled, onSettled)
  }

  void entry.current.then(onSettled, onSettled)
  return entry.current
}
