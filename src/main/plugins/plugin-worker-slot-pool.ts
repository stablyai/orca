export type PluginWorkerSlotLease = {
  release(): void
}

type SlotWaiter = {
  signal: AbortSignal
  resolve: (lease: PluginWorkerSlotLease) => void
  reject: (error: Error) => void
  onAbort: () => void
}

function cancellationError(): Error {
  return new Error('plugin worker activation was cancelled')
}

/** Atomically leases the bounded worker slots and hands releases to queued
 * activations in FIFO order. */
export class PluginWorkerSlotPool {
  private readonly waiters: SlotWaiter[] = []
  private leased = 0
  private disposed = false

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('plugin worker capacity must be a positive integer')
    }
  }

  acquire(signal: AbortSignal): Promise<PluginWorkerSlotLease> {
    if (this.disposed) {
      return Promise.reject(new Error('plugin worker slots are shut down'))
    }
    if (signal.aborted) {
      return Promise.reject(cancellationError())
    }
    if (this.leased < this.capacity && this.waiters.length === 0) {
      this.leased += 1
      return Promise.resolve(this.createLease())
    }
    return new Promise<PluginWorkerSlotLease>((resolve, reject) => {
      let cancelled = false
      const waiter: SlotWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          if (cancelled) {
            return
          }
          cancelled = true
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) {
            this.waiters.splice(index, 1)
          }
          signal.removeEventListener('abort', waiter.onAbort)
          reject(cancellationError())
          this.drain()
        }
      }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(new Error('plugin worker slots are shut down'))
    }
  }

  private createLease(): PluginWorkerSlotLease {
    let released = false
    return {
      release: () => {
        if (released) {
          return
        }
        released = true
        this.leased -= 1
        this.drain()
      }
    }
  }

  private drain(): void {
    while (!this.disposed && this.leased < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(cancellationError())
        continue
      }
      this.leased += 1
      waiter.resolve(this.createLease())
    }
  }
}
