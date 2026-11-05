import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'

import type { MailboxDeliveryBatch } from './orchestration/db/messages/role-mailbox-delivery'

/** One notification: consuming checks it wakes share the batch the first of them takes. */
export class MessageWake {
  private readonly taken = new Map<string, MailboxDeliveryBatch>()

  share(mailboxKey: string, take: () => MailboxDeliveryBatch | undefined) {
    const shared = this.taken.get(mailboxKey)
    if (shared) {
      return { ...shared, replayed: true }
    }
    const batch = take()
    if (batch) {
      this.taken.set(mailboxKey, batch)
    }
    return batch
  }
}

/** A notified wait resolves with its notification's wake. */
export type MessageWaitResult = MessageWake | 'timed_out' | 'cancelled'

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
      this.resolveNotified(
        waiters.filter(
          (waiter) =>
            liveWaiters?.has(waiter) &&
            (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        )
      )
    })
  }

  wait(
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<MessageWaitResult> {
    return new Promise((resolve) => {
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

  /** Wake every waiter on the handle as one notification; false when none is waiting. */
  notify(handle: string): boolean {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters) {
      return false
    }
    this.resolveNotified([...waiters])
    return true
  }

  /** Wake the waiters of every handle with this prefix, one notification per handle. */
  notifyPrefix(prefix: string): void {
    for (const handle of this.waitersByHandle.keys()) {
      if (handle.startsWith(prefix)) {
        this.notify(handle)
      }
    }
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

  /** Internal mailbox routing needs a read-only view of active waiters. */
  get(handle: string): ReadonlySet<RuntimeMessageWaiter> | undefined {
    return this.waitersByHandle.get(handle)
  }

  get map(): ReadonlyMap<string, ReadonlySet<RuntimeMessageWaiter>> {
    return this.waitersByHandle
  }

  /** Resolve the waiters one notification selected, sharing a single wake among them. */
  resolveNotified(waiters: readonly RuntimeMessageWaiter[]): void {
    const wake = new MessageWake()
    for (const waiter of waiters) {
      this.resolve(waiter, wake)
    }
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
