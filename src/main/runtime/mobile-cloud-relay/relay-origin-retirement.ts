import type { RelayDrainMessage } from './relay-control-protocol'
import type { RelayControlOrigin } from './relay-control-origin'

export class RelayOriginRetirement {
  readonly draining = new Set<RelayControlOrigin>()
  readonly basis = new Map<string, RelayControlOrigin>()
  private readonly timers = new Map<RelayControlOrigin, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly current: () => RelayControlOrigin | null,
    private readonly remove: (origin: RelayControlOrigin) => void
  ) {}
  adopt(origin: RelayControlOrigin, _message: RelayDrainMessage): boolean {
    if (origin !== this.current()) {
      return false
    }
    this.draining.add(origin)
    return true
  }
  schedule(origin: RelayControlOrigin, graceMs: number): void {
    const timer = this.timers.get(origin)
    if (timer) {
      clearTimeout(timer)
    }
    this.timers.set(
      origin,
      setTimeout(() => this.close(origin), graceMs)
    )
  }
  maybeClose(origin: RelayControlOrigin): void {
    if (
      !this.draining.has(origin) ||
      origin.pendingRequestCount > 0 ||
      [...this.basis.values()].includes(origin)
    ) {
      return
    }
    this.close(origin)
  }
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.draining.clear()
    this.basis.clear()
  }
  private close(origin: RelayControlOrigin): void {
    if (origin === this.current()) {
      return
    }
    const timer = this.timers.get(origin)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(origin)
    }
    for (const [id, owner] of this.basis) {
      if (owner === origin) {
        this.basis.delete(id)
      }
    }
    this.draining.delete(origin)
    this.remove(origin)
    origin.closeNow()
  }
}
