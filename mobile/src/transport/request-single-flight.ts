import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

type Deferred = {
  promise: Promise<RpcResponse>
  resolve: (value: RpcResponse) => void
  reject: (reason?: unknown) => void
}

type SingleFlightEntry = {
  current: Promise<RpcResponse>
  // Keep one trailing read with latest params so mid-flight refreshes do not receive the older response.
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
    // Coalesce this trigger into one follow-up instead of duplicating or dropping it.
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

  // Deliver queued fresh results to waiting callers; triggers during a follow-up may queue another.
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
