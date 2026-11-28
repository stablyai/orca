import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

/** Lets a burst of exits settle into one inventory. */
const EXIT_SETTLE_MS = 250
/** Chat agents, terminals this app never attached and missed exits are caught by this slow recheck. */
const RECHECK_MS = 60_000
/** A hung decision must not hold reattaches; the generation's own fence still refuses them. */
const DECISION_FENCE_MAX_MS = 2_000

type Timer = ReturnType<typeof setTimeout>

export type LegacyIdleRetirementOptions = {
  current: () => DaemonPtyAdapter
  legacy: () => readonly DaemonPtyAdapter[]
  /** Forgets a generation that accepted retirement. */
  drop: (adapter: DaemonPtyAdapter) => void
  timing?: { exitSettleMs?: number; recheckMs?: number; fenceMaxMs?: number }
}

/** Retires an older generation once it owns nothing; the daemon decides atomically, and reattaches (the only work that reaches it) never overlap that decision. */
export class DaemonRouterLegacyIdleRetirement {
  private readonly timers = new Map<DaemonPtyAdapter, Timer>()
  private readonly checking = new Set<DaemonPtyAdapter>()
  /** Asked again while checking: the running inventory may predate the exit that asked. */
  private readonly checkAgain = new Set<DaemonPtyAdapter>()
  private readonly waitingForQuiet = new Set<DaemonPtyAdapter>()
  private readonly fences = new Set<Promise<void>>()
  private reattachesInFlight = 0
  private reattachEpoch = 0
  private disposed = false

  constructor(private readonly options: LegacyIdleRetirementOptions) {}

  /** Call before routing any spawn that may reach an older generation; call the result when it settles. */
  async admitReattach(): Promise<() => void> {
    while (this.fences.size > 0) {
      await Promise.all([...this.fences])
    }
    // Counted in the same turn the loop saw no fence, so no decision can start between.
    this.reattachesInFlight++
    this.reattachEpoch++
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.reattachesInFlight--
      if (this.reattachesInFlight === 0) {
        for (const adapter of [...this.waitingForQuiet]) {
          this.waitingForQuiet.delete(adapter)
          this.schedule(adapter, 0)
        }
      }
    }
  }

  schedule(adapter: DaemonPtyAdapter, delayMs = this.options.timing?.exitSettleMs ?? EXIT_SETTLE_MS): void {
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    const pending = this.timers.get(adapter)
    if (pending !== undefined) {
      clearTimeout(pending)
    }
    const timer = setTimeout(() => {
      this.timers.delete(adapter)
      void this.check(adapter)
    }, delayMs)
    timer.unref?.()
    this.timers.set(adapter, timer)
  }

  scheduleAll(): void {
    for (const adapter of this.options.legacy()) {
      this.schedule(adapter)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.waitingForQuiet.clear()
    this.checkAgain.clear()
  }

  /** The current generation is never retired here, even when it is empty. */
  private isRetirableLegacy(adapter: DaemonPtyAdapter): boolean {
    const current = this.options.current()
    return (
      adapter !== current &&
      adapter.protocolVersion < current.protocolVersion &&
      adapter.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION &&
      this.options.legacy().includes(adapter)
    )
  }

  private async check(adapter: DaemonPtyAdapter): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.checking.has(adapter)) {
      this.checkAgain.add(adapter)
      return
    }
    if (this.reattachesInFlight > 0) {
      this.waitingForQuiet.add(adapter)
      return
    }
    // Accepted under another router (a restart carries adapters over): it is already leaving.
    if (adapter.hasRetiredForIdle()) {
      this.options.drop(adapter)
      return
    }
    this.checking.add(adapter)
    try {
      await this.retireIfEmpty(adapter)
    } catch (error) {
      // An unanswered inventory proves nothing; ask again later.
      console.warn('[daemon] Older terminal host emptiness check failed:', error)
      this.checkAgainLater(adapter)
    } finally {
      this.checking.delete(adapter)
      if (this.checkAgain.delete(adapter)) {
        this.schedule(adapter)
      }
    }
  }

  private checkAgainLater(adapter: DaemonPtyAdapter): void {
    this.schedule(adapter, this.options.timing?.recheckMs ?? RECHECK_MS)
  }

  private async retireIfEmpty(adapter: DaemonPtyAdapter): Promise<void> {
    const epoch = this.reattachEpoch
    const { sessions, liveRelays } = await adapter.listSessionsAndRelays()
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    if (sessions.length > 0 || liveRelays > 0) {
      this.checkAgainLater(adapter)
      return
    }
    // A reattach that began after the inventory may bring work it missed.
    if (this.reattachesInFlight > 0) {
      this.waitingForQuiet.add(adapter)
      return
    }
    if (this.reattachEpoch !== epoch) {
      this.schedule(adapter)
      return
    }
    // From this turn until the generation answers, reattaches wait instead of probing it.
    let releaseFence!: () => void
    const fence = new Promise<void>((resolve) => (releaseFence = resolve))
    this.fences.add(fence)
    const fenceTimer = setTimeout(() => {
      this.fences.delete(fence)
      releaseFence()
    }, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
    fenceTimer.unref?.()
    try {
      const result = await adapter.requestIdleRetirement()
      if (this.disposed && result.state !== 'retiring') {
        return
      }
      if (result.state === 'retiring') {
        this.options.drop(adapter)
        return
      }
      if (result.state === 'busy') {
        this.checkAgainLater(adapter)
      }
      // Unanswered proves nothing (another client may have given it work); asking again soon also reopens its admission.
      if (result.state === 'unverifiable') {
        this.schedule(adapter, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
      }
    } finally {
      clearTimeout(fenceTimer)
      this.fences.delete(fence)
      releaseFence()
    }
  }
}
