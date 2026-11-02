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

  get leasedCount(): number {
    return this.leased
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
 *  so would otherwise starve every other plugin of the shared one. Past the soft cap a hook worker
 *  still starts (logged once), so admission never waits on a worker that never stops. */
export class PluginWorkerSlots {
  private readonly active: PluginWorkerSlotPool
  // Why unbounded: waiting here would hang refresh, disable and uninstall behind hook workers.
  private readonly keepWarm = new PluginWorkerSlotPool(Number.MAX_SAFE_INTEGER)
  private keepWarmCapLogged = false

  constructor(
    maxActive: number,
    private readonly maxKeepWarm = PLUGIN_WORKER_MAX_KEEP_WARM_DEFAULT
  ) {
    this.active = new PluginWorkerSlotPool(maxActive)
  }

  for(spec: { keepWarm?: true }, log: (level: 'warn', line: string) => void): PluginWorkerSlotPool {
    if (!spec.keepWarm) {
      return this.active
    }
    if (this.keepWarm.leasedCount >= this.maxKeepWarm && !this.keepWarmCapLogged) {
      this.keepWarmCapLogged = true
      log(
        'warn',
        `more than ${this.maxKeepWarm} plugins with hooks are running; each extra one adds a process`
      )
    }
    return this.keepWarm
  }

  dispose(): void {
    this.active.dispose()
    this.keepWarm.dispose()
  }
}
