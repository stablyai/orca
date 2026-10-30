import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'

export type MessageWaitResult = 'notified' | 'timed_out' | 'cancelled'

/** A notified check retains its opportunity until its actual read/reserve continuation finishes. */
export class MessageWaitScope {
  private readonly observations = new Map<string, () => void>()
  private notification: (() => void) | undefined
  private completed = false
  observe(key: string, install: () => () => void): void {
    if (!this.completed && !this.observations.has(key)) {
      this.observations.set(key, install())
    }
  }
  bind(release: () => void): void {
    const previous = this.notification
    this.notification = this.completed ? undefined : release
    previous?.()
    if (this.completed) {
      release()
    }
  }
  complete(): boolean {
    if (this.completed) {
      return false
    }
    this.completed = true
    this.notification?.()
    this.notification = undefined
    const hadObservation = this.observations.size !== 0
    for (const release of this.observations.values()) {
      release()
    }
    this.observations.clear()
    return hadObservation
  }
}

export type RuntimeMessageWaiter = {
  handle: string
  typeFilter: string[] | undefined
  resolve: (result: MessageWaitResult) => void
  timeout: NodeJS.Timeout | null
  abortCleanup: (() => void) | null
  notified: boolean
  scope?: MessageWaitScope
}

export class RuntimeMessageWaiters {
  constructor(private readonly onRelease?: (handle: string, types?: readonly string[]) => void) {}
  private readonly waitersByHandle = new Map<string, Set<RuntimeMessageWaiter>>()

  notifyRouted(handle: string, types: readonly string[]): void {
    if (types.length === 0) {
      return
    }
    const waiters = [...(this.waitersByHandle.get(handle) ?? [])]
    queueMicrotask(() => {
      for (const waiter of waiters) {
        if (
          this.waitersByHandle.get(handle)?.has(waiter) &&
          (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        ) {
          this.resolve(waiter, 'notified')
        }
      }
    })
  }

  observe(handle: string, scope: MessageWaitScope, typeFilter?: string[]): void {
    scope.observe(
      JSON.stringify([handle, typeFilter ? [...new Set(typeFilter)].sort() : null]),
      () => {
        const waiter: RuntimeMessageWaiter = {
          handle,
          typeFilter,
          scope,
          resolve: () => {},
          timeout: null,
          abortCleanup: null,
          notified: true
        }
        const waiters = this.waitersByHandle.get(handle) ?? new Set<RuntimeMessageWaiter>()
        this.waitersByHandle.set(handle, waiters)
        waiters.add(waiter)
        return () => this.remove(waiter)
      }
    )
  }

  wait(
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      scope?: MessageWaitScope
    }
  ): Promise<MessageWaitResult> {
    if (options?.scope) {
      this.observe(handle, options.scope, options.typeFilter)
    }
    return new Promise((resolve) => {
      const waiter: RuntimeMessageWaiter = {
        handle,
        typeFilter: options?.typeFilter,
        resolve,
        timeout: null,
        abortCleanup: null,
        notified: false,
        scope: options?.scope
      }
      const waiters = this.waitersByHandle.get(handle) ?? new Set()
      this.waitersByHandle.set(handle, waiters)
      waiters.add(waiter)
      options?.scope?.bind(() => this.resolve(waiter, 'cancelled'))
      if (waiter.notified) {
        return
      }
      const signal = options?.signal
      if (signal?.aborted) {
        this.resolve(waiter, 'cancelled')
        return
      }
      if (signal) {
        const onAbort = () => this.resolve(waiter, 'cancelled')
        waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiter.timeout = setTimeout(
        () => this.resolve(waiter, 'timed_out'),
        options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS
      )
    })
  }

  cancel(handle: string): void {
    for (const waiter of this.waitersByHandle.get(handle) ?? []) {
      this.resolve(waiter, 'cancelled')
    }
  }

  dispose(): void {
    for (const waiters of this.waitersByHandle.values()) {
      for (const waiter of waiters) {
        this.remove(waiter, false)
        this.resolve(waiter, 'cancelled')
      }
    }
  }

  consumerCompleted(handle: string, types?: readonly string[]): void {
    try {
      this.onRelease?.(handle, types)
    } catch (error) {
      console.warn('[orchestration] notifying completed mail consumer failed', error)
    }
  }

  get(handle: string): ReadonlySet<RuntimeMessageWaiter> | undefined {
    return this.waitersByHandle.get(handle)
  }
  get map(): ReadonlyMap<string, ReadonlySet<RuntimeMessageWaiter>> {
    return this.waitersByHandle
  }
  resolveNotified(waiter: RuntimeMessageWaiter): void {
    this.resolve(waiter, 'notified')
  }

  private resolve(waiter: RuntimeMessageWaiter, result: MessageWaitResult): void {
    if (waiter.notified) {
      return
    }
    waiter.notified = true
    this.cleanup(waiter)
    this.remove(waiter, !waiter.scope)
    waiter.resolve(result)
  }

  private cleanup(waiter: RuntimeMessageWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    waiter.timeout = null
    waiter.abortCleanup?.()
    waiter.abortCleanup = null
  }
  private remove(waiter: RuntimeMessageWaiter, notify = true): void {
    this.cleanup(waiter)
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters?.delete(waiter)) {
      return
    }
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
    if (notify) {
      this.consumerCompleted(waiter.handle, waiter.typeFilter)
    }
  }
}
