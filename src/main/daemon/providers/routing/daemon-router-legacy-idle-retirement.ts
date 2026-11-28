import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import {
  DaemonConnectionLostError,
  isDaemonEndpointGoneError,
  TerminalSessionOwnerUnverifiedError
} from '../../protocol/daemon-errors'

/** Lets a burst of exits settle into one inventory. */
const EXIT_SETTLE_MS = 250
// Transitional, for generations older than `retireWhenIdle` (v63 and before); remove once those are gone.
/** Their work that sends this app no exit (chat agents, unattached terminals) is rechecked, backing off. */
const RECHECK_MS = 60_000
const RECHECK_MAX_MS = 30 * 60_000
/** A hung decision must not hold reattaches; the generation's own fence still refuses them. */
const DECISION_FENCE_MAX_MS = 2_000
/** A held generation closes as it retires; its endpoint is proven gone within a few of these. */
const RETIRED_CONFIRM_DELAYS_MS = [50, 100, 250, 500, 1_000]

type Timer = ReturnType<typeof setTimeout>

export type LegacyIdleRetirementOptions = {
  current: () => DaemonPtyAdapter
  legacy: () => readonly DaemonPtyAdapter[]
  /** Forgets a generation that accepted retirement. */
  drop: (adapter: DaemonPtyAdapter) => void
  timing?: { exitSettleMs?: number; recheckMs?: number; recheckMaxMs?: number; fenceMaxMs?: number }
}

/**
 * Retires an older generation once it owns nothing. Held generations (`retireWhenIdle`) decide by
 * themselves, atomically, and are forgotten once their endpoint is gone. Older ones are asked by
 * this app (`shutdownIfIdle`) after their exits, and reattaches never overlap that decision.
 */
export class DaemonRouterLegacyIdleRetirement {
  private readonly timers = new Map<DaemonPtyAdapter, Timer>()
  private readonly checking = new Set<DaemonPtyAdapter>()
  /** Asked again while checking: the running inventory may predate the exit that asked. */
  private readonly checkAgain = new Set<DaemonPtyAdapter>()
  private readonly waitingForQuiet = new Set<DaemonPtyAdapter>()
  private readonly fences = new Set<Promise<void>>()
  // Weak: a generation can also leave through the endpoint-loss path, which never tells this class.
  private readonly recheckDelays = new WeakMap<DaemonPtyAdapter, number>()
  private readonly modes = new WeakMap<DaemonPtyAdapter, 'asking' | 'held' | 'pre-rpc'>()
  private readonly lostListeners = new Map<DaemonPtyAdapter, () => void>()
  private reattachesInFlight = 0
  private reattachEpoch = 0
  private disposed = false

  constructor(private readonly options: LegacyIdleRetirementOptions) {}

  /** Call before routing any spawn that may reach an older generation; call the result when it settles. */
  async admitReattach(): Promise<() => void> {
    while (this.fences.size > 0) {
      await Promise.all(this.fences)
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
        for (const adapter of this.waitingForQuiet) {
          this.waitingForQuiet.delete(adapter)
          this.schedule(adapter, 0)
        }
      }
    }
  }

  /** An exit, discovery or reattach on the generation. */
  noteActivity(adapter: DaemonPtyAdapter): void {
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    // Accepted under another router (a restart carries adapters over): it is already leaving.
    if (adapter.hasRetiredForIdle()) {
      this.forget(adapter)
      return
    }
    const mode = this.modes.get(adapter)
    if (mode === undefined && adapter.wasAskedToRetireWhenIdle()) {
      this.adoptHeld(adapter)
      void this.confirmRetired(adapter, false)
    } else if (mode === undefined) {
      void this.hold(adapter)
    } else if (mode === 'held' && !adapter.isHeldForRetirement()) {
      void this.confirmRetired(adapter, false)
    } else if (mode === 'pre-rpc') {
      this.recheckDelays.delete(adapter)
      this.schedule(adapter)
    }
  }

  /** After a spawn failed: true when a held generation retired under it (already forgotten, or now). */
  async settleHeldRetirements(
    error: unknown,
    generationsAtStart: number,
    target: DaemonPtyAdapter | undefined
  ): Promise<boolean> {
    if (!mayComeFromRetirement(error)) {
      return false
    }
    const held = this.options.legacy().filter((adapter) => this.modes.get(adapter) === 'held')
    // Only the generation the spawn reached can have refused it before its close arrives.
    const settled = await Promise.all(
      held.map((adapter) => this.confirmRetired(adapter, adapter === target))
    )
    return settled.includes(true) || this.options.legacy().length < generationsAtStart
  }

  private async hold(adapter: DaemonPtyAdapter): Promise<void> {
    this.modes.set(adapter, 'asking')
    const result = await adapter.askRetireWhenIdle(this.options.current().protocolVersion)
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    if (result === 'unanswered') {
      // The next exit, discovery or reattach asks again.
      this.modes.delete(adapter)
      return
    }
    if (result === 'unsupported') {
      this.modes.set(adapter, 'pre-rpc')
      this.schedule(adapter)
      return
    }
    this.adoptHeld(adapter)
  }

  private adoptHeld(adapter: DaemonPtyAdapter): void {
    this.modes.set(adapter, 'held')
    if (!this.lostListeners.has(adapter)) {
      this.lostListeners.set(
        adapter,
        adapter.onConnectionLost(() => void this.confirmRetired(adapter, false))
      )
    }
  }

  /** A held connection only closes when the daemon retires, stops, or the link drops. */
  private async confirmRetired(adapter: DaemonPtyAdapter, awaitClose: boolean): Promise<boolean> {
    for (const delayMs of RETIRED_CONFIRM_DELAYS_MS) {
      if (this.disposed || this.modes.get(adapter) !== 'held') {
        return false
      }
      const verdict = await adapter.confirmRetiredWhenIdle()
      if (verdict === 'retired') {
        this.forget(adapter)
        return true
      }
      // Reconnected, here or by another path: a new connection keeps the daemon alive until asked again.
      if (
        verdict === 'reconnected' ||
        (verdict === 'connected' && !adapter.isHeldForRetirement())
      ) {
        void this.hold(adapter)
        return false
      }
      // A refused spawn can beat the close that follows a retirement.
      if (verdict === 'connected' && !awaitClose) {
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
    }
    if (!this.disposed && this.modes.get(adapter) === 'held' && !adapter.isHeldForRetirement()) {
      // Still unproven: endpoint-loss handling keeps it, and the next activity looks again.
      this.modes.delete(adapter)
    }
    return false
  }

  private schedule(
    adapter: DaemonPtyAdapter,
    delayMs = this.options.timing?.exitSettleMs ?? EXIT_SETTLE_MS
  ): void {
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

  noteAll(): void {
    for (const adapter of this.options.legacy()) {
      this.noteActivity(adapter)
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
    for (const stop of this.lostListeners.values()) {
      stop()
    }
    this.lostListeners.clear()
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
    if (this.disposed || this.modes.get(adapter) !== 'pre-rpc') {
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
      this.forget(adapter)
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
    const delayMs = this.recheckDelays.get(adapter) ?? this.options.timing?.recheckMs ?? RECHECK_MS
    this.recheckDelays.set(
      adapter,
      Math.min(delayMs * 2, this.options.timing?.recheckMaxMs ?? RECHECK_MAX_MS)
    )
    this.schedule(adapter, delayMs)
  }

  private forget(adapter: DaemonPtyAdapter): void {
    this.recheckDelays.delete(adapter)
    this.lostListeners.get(adapter)?.()
    this.lostListeners.delete(adapter)
    this.options.drop(adapter)
  }

  private async retireIfEmpty(adapter: DaemonPtyAdapter): Promise<void> {
    const epoch = this.reattachEpoch
    const { sessions, liveRelays } = await adapter.listSessionsAndRelays()
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    // A generation still fenced by an unanswered attempt is asked again: its refusal reopens it.
    if ((sessions.length > 0 || liveRelays > 0) && !adapter.isIdleRetirementAdmissionClosed()) {
      const watched = new Set(adapter.getActiveSessionIds())
      if (liveRelays > 0 || sessions.some((session) => !watched.has(session.sessionId))) {
        this.checkAgainLater(adapter)
      }
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
        this.forget(adapter)
        return
      }
      if (result.state === 'busy') {
        this.checkAgainLater(adapter)
      }
      // Unanswered proves nothing (another client may have given it work); asking again soon also reopens its admission.
      if (result.state === 'unverifiable') {
        if (this.recheckDelays.has(adapter)) {
          this.checkAgainLater(adapter)
        } else {
          this.recheckDelays.set(adapter, this.options.timing?.recheckMs ?? RECHECK_MS)
          this.schedule(adapter, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
        }
      }
    } finally {
      clearTimeout(fenceTimer)
      this.fences.delete(fence)
      releaseFence()
    }
  }
}

/** Refusals a retiring generation gives work that reached it after it decided. */
function mayComeFromRetirement(error: unknown): boolean {
  return (
    error instanceof DaemonConnectionLostError ||
    error instanceof TerminalSessionOwnerUnverifiedError ||
    isDaemonEndpointGoneError(error) ||
    (error instanceof Error &&
      (error.message.includes('temporarily unavailable') ||
        error.message.includes('decommissioning')))
  )
}
