import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { RpcResponse } from './types'

type Deferred = {
  promise: Promise<RpcResponse>
  resolve: (value: RpcResponse) => void
  reject: (reason?: unknown) => void
}

type SingleFlightEntry = {
  current: Promise<RpcResponse>
  // Keep one trailing read with latest params so mid-flight refreshes do not receive the older response.
  followUp: {
    deferred: Deferred
    params: unknown
    options?: SingleFlightOptions
    deadline?: number
    timeout?: ReturnType<typeof setTimeout>
  } | null
}

type SingleFlightOptions = {
  key: string
  signal?: AbortSignal
  requestOptions: SendRequestOptions
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
  params?: unknown,
  options?: SingleFlightOptions
): Promise<RpcResponse> {
  if (options?.signal?.aborted) {
    return Promise.reject(options.signal.reason)
  }
  const key = options?.key ?? requestKind
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
      return options
        ? client.sendRequest(requestKind, params, options.requestOptions)
        : client.sendRequest(requestKind, params)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const existing = requestsByKind.get(key)
  if (existing) {
    // Retired queued views must not donate their expired budget to the next view.
    if (existing.followUp?.options?.signal?.aborted) {
      clearTimeout(existing.followUp.timeout)
      existing.followUp.deferred.reject(existing.followUp.options.signal.reason)
      existing.followUp = null
    }
    // Coalesce this trigger into one follow-up without extending its original operation budget.
    if (existing.followUp) {
      existing.followUp.params = params
      existing.followUp.options = options
    } else {
      const timeoutMs = options?.requestOptions.timeoutMs
      const followUp: NonNullable<SingleFlightEntry['followUp']> = {
        deferred: makeDeferred(),
        params,
        options,
        ...(timeoutMs === undefined ? {} : { deadline: Date.now() + timeoutMs })
      }
      existing.followUp = followUp
      if (timeoutMs !== undefined) {
        followUp.timeout = setTimeout(() => {
          if (existing.followUp !== followUp) {
            return
          }
          existing.followUp = null
          followUp.deferred.reject(new Error('Current-request read timed out in queue'))
        }, timeoutMs)
      }
    }
    return existing.followUp.deferred.promise
  }

  const entry: SingleFlightEntry = { current: send(), followUp: null }
  requestsByKind.set(key, entry)

  const cleanup = (): void => {
    if (requestsByKind.get(key) !== entry) {
      return
    }
    requestsByKind.delete(key)
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
    clearTimeout(followUp.timeout)
    let next: Promise<RpcResponse>
    try {
      followUp.options?.signal?.throwIfAborted()
      const remaining = followUp.deadline === undefined ? undefined : followUp.deadline - Date.now()
      if (remaining !== undefined && remaining <= 0) {
        throw new Error('Current-request read timed out in queue')
      }
      next = followUp.options
        ? client.sendRequest(requestKind, followUp.params, {
            ...followUp.options.requestOptions,
            ...(remaining === undefined ? {} : { timeoutMs: remaining })
          })
        : client.sendRequest(requestKind, followUp.params)
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
