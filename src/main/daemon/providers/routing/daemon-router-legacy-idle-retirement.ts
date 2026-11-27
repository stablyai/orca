import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

/** Lets a burst of exits settle into one inventory. */
const EXIT_SETTLE_MS = 250
/** Work this app sees no exit for (chat agents, terminals it never attached) is rechecked this slowly. */
const UNWATCHED_WORK_RECHECK_MS = 60_000
/** A hung decision must not hold reattaches; the generation's own fence still refuses them. */
const DECISION_FENCE_MAX_MS = 2_000

type Timer = ReturnType<typeof setTimeout>

export type LegacyIdleRetirementOptions = {
  current: () => DaemonPtyAdapter
  legacy: () => readonly DaemonPtyAdapter[]
  /** Forgets a generation that retired, or that owned nothing when contact was lost mid-decision. */
  drop: (adapter: DaemonPtyAdapter) => void
  timing?: { exitSettleMs?: number; recheckMs?: number; fenceMaxMs?: number }
}

/**
 * Retires an older daemon generation once it owns nothing. The daemon decides atomically
 * (`shutdownIfIdle`); reattaches, the only work that can reach an older generation, are
 * counted so none is in flight when that decision is asked for, and wait it out.
 */
export class DaemonRouterLegacyIdleRetirement {
  private readonly timers = new Map<DaemonPtyAdapter, Timer>()
  private readonly checking = new Set<DaemonPtyAdapter>()
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
    if (this.disposed || this.checking.has(adapter)) {
      return
    }
    if (this.reattachesInFlight > 0) {
      this.waitingForQuiet.add(adapter)
      return
    }
    this.checking.add(adapter)
    try {
      await this.retireIfEmpty(adapter)
    } catch (error) {
      // An unanswered inventory proves nothing; the next exit or recheck asks again.
      console.warn('[daemon] Older terminal host emptiness check failed:', error)
    } finally {
      this.checking.delete(adapter)
    }
  }

  private async retireIfEmpty(adapter: DaemonPtyAdapter): Promise<void> {
    const epoch = this.reattachEpoch
    const { sessions, liveRelays } = await adapter.listSessionsAndRelays()
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    if (sessions.length > 0 || liveRelays > 0) {
      const watched = new Set(adapter.getActiveSessionIds())
      if (liveRelays > 0 || sessions.some((session) => !watched.has(session.sessionId))) {
        this.schedule(adapter, this.options.timing?.recheckMs ?? UNWATCHED_WORK_RECHECK_MS)
      }
      return
    }
    if (this.reattachesInFlight > 0 || this.reattachEpoch !== epoch) {
      // A reattach began after the inventory; it may own work the inventory missed.
      this.waitingForQuiet.add(adapter)
      if (this.reattachesInFlight === 0) {
        this.waitingForQuiet.delete(adapter)
        this.schedule(adapter)
      }
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
      if (this.disposed) {
        return
      }
      // Unverifiable: it owned nothing and refuses new work, so leaving lets it retire on disconnect.
      if (result.state === 'retiring' || result.state === 'unverifiable') {
        this.options.drop(adapter)
        return
      }
      if (result.state === 'busy') {
        this.schedule(adapter, this.options.timing?.recheckMs ?? UNWATCHED_WORK_RECHECK_MS)
      }
    } finally {
      clearTimeout(fenceTimer)
      this.fences.delete(fence)
      releaseFence()
    }
  }
}
