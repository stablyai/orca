import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'

export type MessageWaitResult = 'notified' | 'timed_out' | 'cancelled' | 'waiter_exists'

export type RuntimeMessageWaiter = {
  handle: string
  typeFilter: string[] | undefined
  resolve: (result: MessageWaitResult) => void
  timeout: NodeJS.Timeout | null
  abortCleanup: (() => void) | null
}

export class RuntimeMessageWaiters {
  private readonly waitersByHandle = new Map<string, Set<RuntimeMessageWaiter>>()

  notifyRouted(handle: string, types: readonly string[]): void {
    if (types.length === 0) {
      return
    }
    const waiters = [...(this.waitersByHandle.get(handle) ?? [])]
    if (waiters.length === 0) {
      return
    }
    queueMicrotask(() => {
      const liveWaiters = this.waitersByHandle.get(handle)
      for (const waiter of waiters) {
        if (
          liveWaiters?.has(waiter) &&
          (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        ) {
          this.resolve(waiter, 'notified')
        }
      }
    })
  }

  wait(
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      exclusive?: boolean
    }
  ): Promise<MessageWaitResult> {
    return new Promise((resolve) => {
      const currentWaiters = this.waitersByHandle.get(handle)
      if (options?.exclusive && currentWaiters && currentWaiters.size > 0) {
        resolve('waiter_exists')
        return
      }
      const waiter: RuntimeMessageWaiter = {
        handle,
        typeFilter: options?.typeFilter,
        resolve,
        timeout: null,
        abortCleanup: null
      }
      const signal = options?.signal
      const onAbort = (): void => {
        this.remove(waiter)
        resolve('cancelled')
      }
      if (signal) {
        if (signal.aborted) {
          resolve('cancelled')
          return
        }
        waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiter.timeout = setTimeout(() => {
        this.remove(waiter)
        resolve('timed_out')
      }, options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS)
      let waiters = this.waitersByHandle.get(handle)
      if (!waiters) {
        waiters = new Set()
        this.waitersByHandle.set(handle, waiters)
      }
      waiters.add(waiter)
    })
  }

  cancel(handle: string): void {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters) {
      return
    }
    for (const waiter of waiters) {
      this.resolve(waiter, 'cancelled')
    }
  }

  typeHasLiveWaiter(handle: string, messageType: string): boolean {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters) {
      return false
    }
    for (const waiter of waiters) {
      if (!waiter.typeFilter || waiter.typeFilter.includes(messageType)) {
        return true
      }
    }
    return false
  }

  /** Internal mailbox routing needs a read-only view of active waiters. */
  get(handle: string): ReadonlySet<RuntimeMessageWaiter> | undefined {
    return this.waitersByHandle.get(handle)
  }

  get map(): ReadonlyMap<string, ReadonlySet<RuntimeMessageWaiter>> {
    return this.waitersByHandle
  }

  /** Resolve a waiter selected by mailbox routing. */
  resolveNotified(waiter: RuntimeMessageWaiter): void {
    this.resolve(waiter, 'notified')
  }

  private resolve(waiter: RuntimeMessageWaiter, result: MessageWaitResult): void {
    this.remove(waiter)
    waiter.resolve(result)
  }

  private remove(waiter: RuntimeMessageWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    waiter.timeout = null
    waiter.abortCleanup?.()
    waiter.abortCleanup = null
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
  }
}
