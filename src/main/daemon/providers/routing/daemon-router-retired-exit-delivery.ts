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

type Lingering = { timer: ReturnType<typeof setTimeout>; stopListening: () => void }

/**
 * A retired older generation owns nothing, so it gets no new work at once. It stays subscribed
 * until its connection has closed (which delivers every event still buffered on its stream) and no
 * watched terminal's exit is pending (a WSL pane's comes late), or until the bound passes.
 */
export class DaemonRouterRetiredExitDelivery {
  private readonly lingering = new Map<DaemonPtyAdapter, Lingering>()

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

  /** The generation retired, its connection closed, or one of its owed exits arrived. */
  settle(adapter: DaemonPtyAdapter): void {
    if (adapter.hasDeliveredOwedEvents()) {
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
    for (const [adapter, { timer, stopListening }] of this.lingering) {
      clearTimeout(timer)
      stopListening()
      if (!carried) {
        this.options.release(adapter)
      }
    }
    this.lingering.clear()
  }

  private wait(adapter: DaemonPtyAdapter): void {
    const timer = setTimeout(() => this.finish(adapter), this.options.maxMs ?? EXIT_DELIVERY_MAX_MS)
    timer.unref?.()
    // Fires after the client drains what its stream had buffered.
    const stopListening = adapter.onConnectionLost(() => this.settle(adapter))
    this.lingering.set(adapter, { timer, stopListening })
  }

  private finish(adapter: DaemonPtyAdapter): void {
    const entry = this.lingering.get(adapter)
    if (entry === undefined) {
      this.options.drop(adapter)
      return
    }
    clearTimeout(entry.timer)
    entry.stopListening()
    this.lingering.delete(adapter)
    this.options.release(adapter)
  }
}
