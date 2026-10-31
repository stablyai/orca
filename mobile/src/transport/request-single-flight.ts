import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { RpcResponse } from './types'

type Deferred = {
  promise: Promise<RpcResponse>
  resolve: (value: RpcResponse) => void
  reject: (reason?: unknown) => void
}

type SingleFlightEntry = {
  current: Promise<RpcResponse>
  first?: QueuedRequest
  last?: QueuedRequest
  polling?: QueuedRequest
}

type QueuedRequest = {
  previous?: QueuedRequest
  next?: QueuedRequest
  queued: boolean
  deferred: Deferred
  params: unknown
  options?: SingleFlightOptions
  deadline?: number
  timeout?: ReturnType<typeof setTimeout>
  detachAbort?: () => void
}

type SingleFlightOptions = {
  key: string
  signal?: AbortSignal
  requestOptions: SendRequestOptions
}

const inFlightRequests = new WeakMap<RpcClient, Map<string, Map<string, SingleFlightEntry>>>()

function unlink(entry: SingleFlightEntry, operation: QueuedRequest): void {
  if (operation.previous) {
    operation.previous.next = operation.next
  } else {
    entry.first = operation.next
  }
  if (operation.next) {
    operation.next.previous = operation.previous
  } else {
    entry.last = operation.previous
  }
  if (entry.polling === operation) {
    entry.polling = undefined
  }
  operation.queued = false
  operation.previous = operation.next = undefined
}

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
    // Poll triggers want the latest value; scoped immutable pieces each own their params and signal.
    const polling = options ? undefined : existing.polling
    if (polling) {
      polling.params = params
      return polling.deferred.promise
    }
    const timeoutMs = options?.requestOptions.timeoutMs
    const followUp: QueuedRequest = {
      queued: true,
      previous: existing.last,
      deferred: makeDeferred(),
      params,
      options,
      ...(timeoutMs === undefined ? {} : { deadline: Date.now() + timeoutMs })
    }
    if (existing.last) {
      existing.last.next = followUp
    } else {
      existing.first = followUp
    }
    existing.last = followUp
    if (!options) {
      existing.polling = followUp
    }
    const withdraw = (reason: unknown): void => {
      if (!followUp.queued) {
        return
      }
      unlink(existing, followUp)
      clearTimeout(followUp.timeout)
      followUp.detachAbort?.()
      followUp.deferred.reject(reason)
    }
    const signal = options?.signal
    if (signal) {
      const abort = () => withdraw(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      followUp.detachAbort = () => signal.removeEventListener('abort', abort)
    }
    if (timeoutMs !== undefined) {
      followUp.timeout = setTimeout(
        () => withdraw(new Error('Current-request read timed out in queue')),
        timeoutMs
      )
    }
    return followUp.deferred.promise
  }

  const entry: SingleFlightEntry = { current: send() }
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
    const followUp = entry.first
    if (!followUp) {
      cleanup()
      return
    }
    unlink(entry, followUp)
    clearTimeout(followUp.timeout)
    followUp.detachAbort?.()
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
