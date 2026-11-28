import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'

/** Past a WSL pane's exit classification (up to ~10s), so its exit still reaches the app. */
const EXIT_DELIVERY_MAX_MS = 30_000

export type RetiredExitDeliveryOptions = {
  /** Stops routing work to the generation; its exit subscription stays. */
  unroute: (adapter: DaemonPtyAdapter) => boolean
  /** Unsubscribes and disconnects a generation already unrouted. */
  release: (adapter: DaemonPtyAdapter) => void
  /** Unroutes, unsubscribes and disconnects. */
  drop: (adapter: DaemonPtyAdapter) => void
  maxMs: number | undefined
}

/**
 * A retired older generation owns nothing, so it gets no new work at once; but exits it still owes
 * this app's terminals (a WSL pane's comes late) arrive before it is unsubscribed.
 */
export class DaemonRouterRetiredExitDelivery {
  private readonly lingering = new Map<DaemonPtyAdapter, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: RetiredExitDeliveryOptions) {}

  isLingering(adapter: DaemonPtyAdapter): boolean {
    return this.lingering.has(adapter)
  }

  adapters(): DaemonPtyAdapter[] {
    return Array.from(this.lingering.keys())
  }

  /** Carried over from the router a restart replaced, already unrouted; settled once that router is built. */
  adopt(adapter: DaemonPtyAdapter): void {
    this.wait(adapter)
    queueMicrotask(() => this.settle(adapter))
  }

  /** The generation retired, or one of its owed exits arrived. */
  settle(adapter: DaemonPtyAdapter): void {
    if (!adapter.hasWatchedSessions()) {
      this.finish(adapter)
      return
    }
    if (this.lingering.has(adapter) || !this.options.unroute(adapter)) {
      return
    }
    this.wait(adapter)
  }

  /** `carried`: a restart hands these to the next router, which releases them. */
  dispose(carried: boolean): void {
    for (const [adapter, timer] of this.lingering) {
      clearTimeout(timer)
      if (!carried) {
        this.options.release(adapter)
      }
    }
    this.lingering.clear()
  }

  private wait(adapter: DaemonPtyAdapter): void {
    const timer = setTimeout(() => this.finish(adapter), this.options.maxMs ?? EXIT_DELIVERY_MAX_MS)
    timer.unref?.()
    this.lingering.set(adapter, timer)
  }

  private finish(adapter: DaemonPtyAdapter): void {
    const timer = this.lingering.get(adapter)
    if (timer === undefined) {
      this.options.drop(adapter)
      return
    }
    clearTimeout(timer)
    this.lingering.delete(adapter)
    this.options.release(adapter)
  }
}
