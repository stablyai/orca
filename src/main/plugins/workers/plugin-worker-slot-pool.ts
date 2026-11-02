import { PLUGIN_WORKER_MAX_KEEP_WARM_DEFAULT } from '../../../shared/plugins/workers/plugin-host-protocol'

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

/** Hand bounded worker-slot leases to waiting activations in FIFO order. */
export class PluginWorkerSlotPool {
  private readonly waiters: SlotWaiter[] = []
  private leased = 0
  private disposed = false

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('plugin worker capacity must be a positive integer')
    }
  }

  /** Whether an acquire now would wait. */
  get full(): boolean {
    return this.leased >= this.capacity || this.waiters.length > 0
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
          if (index !== -1) {
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

/** The active-worker cap, plus a separate soft cap for hook workers, which never idle out and
 *  so would otherwise starve every other plugin of the shared one. */
export class PluginWorkerSlots {
  private readonly active: PluginWorkerSlotPool
  private readonly keepWarm: PluginWorkerSlotPool
  private keepWarmCapLogged = false

  constructor(maxActive: number, maxKeepWarm = PLUGIN_WORKER_MAX_KEEP_WARM_DEFAULT) {
    this.active = new PluginWorkerSlotPool(maxActive)
    this.keepWarm = new PluginWorkerSlotPool(maxKeepWarm)
  }

  for(spec: { keepWarm?: true }, log: (level: 'warn', line: string) => void): PluginWorkerSlotPool {
    if (!spec.keepWarm) {
      return this.active
    }
    if (this.keepWarm.full && !this.keepWarmCapLogged) {
      this.keepWarmCapLogged = true
      log('warn', 'too many plugins with hooks are running; this one waits until another stops')
    }
    return this.keepWarm
  }

  dispose(): void {
    this.active.dispose()
    this.keepWarm.dispose()
  }
}
