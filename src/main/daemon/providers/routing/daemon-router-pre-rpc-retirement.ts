import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'

// Transitional, for generations older than `retireWhenIdle` (v63 and before); remove once those are gone.
/** Lets a burst of exits settle into one inventory. */
const EXIT_SETTLE_MS = 250
/** Their work that sends this app no exit (chat agents, unattached terminals) is rechecked, backing off. */
const RECHECK_MS = 60_000
const RECHECK_MAX_MS = 30 * 60_000
/** Then it stops until the next exit: an older daemon still holding such work stays, as before, until quit. */
const RECHECK_LIMIT = 6
/** A hung decision must not hold reattaches; the generation's own fence still refuses them. */
const DECISION_FENCE_MAX_MS = 2_000

type Timer = ReturnType<typeof setTimeout>

export type PreRpcRetirementTiming = {
  exitSettleMs?: number
  recheckMs?: number
  recheckMaxMs?: number
  fenceMaxMs?: number
  exitDeliveryMaxMs?: number
}

/** Asks an older generation that predates `retireWhenIdle` to retire after its exits; reattaches never overlap that decision. */
export class DaemonRouterPreRpcRetirement {
  private readonly timers = new Map<DaemonPtyAdapter, Timer>()
  private readonly checking = new Set<DaemonPtyAdapter>()
  /** Asked again while checking: the running inventory may predate the exit that asked. */
  private readonly checkAgain = new Set<DaemonPtyAdapter>()
  private readonly waitingForQuiet = new Set<DaemonPtyAdapter>()
  /** Each decision's fence, by the generation deciding. */
  private readonly fences = new Map<Promise<void>, DaemonPtyAdapter>()
  // Weak: a generation can also leave through the endpoint-loss path, which never tells this class.
  private readonly recheckDelays = new WeakMap<DaemonPtyAdapter, number>()
  private readonly rechecks = new WeakMap<DaemonPtyAdapter, number>()
  private readonly decisions = new Map<DaemonPtyAdapter, Promise<unknown>>()
  /** Spawns it refused, waiting for a decision deferred until reattaches are quiet. */
  private readonly decisionWaiters = new Map<DaemonPtyAdapter, Set<() => void>>()
  private reattachesInFlight = 0
  private reattachEpoch = 0
  private disposed = false

  constructor(
    private readonly options: {
      /** Still an older generation on this path. */
      applies: (adapter: DaemonPtyAdapter) => boolean
      /** It accepted retirement. */
      retired: (adapter: DaemonPtyAdapter) => void
      timing: PreRpcRetirementTiming | undefined
    }
  ) {}

  /**
   * Call before routing any spawn that may reach an older generation; call the result when it settles.
   * A spawn already routed to one generation waits only for that generation's decision.
   */
  async admitReattach(route?: DaemonPtyAdapter): Promise<() => void> {
    for (let pending = this.fencesFor(route); pending.length > 0; pending = this.fencesFor(route)) {
      await Promise.all(pending)
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

  private fencesFor(route: DaemonPtyAdapter | undefined): Promise<void>[] {
    const pending: Promise<void>[] = []
    for (const [fence, adapter] of this.fences) {
      if (route === undefined || adapter === route) {
        pending.push(fence)
      }
    }
    return pending
  }

  /** An exit or discovery: check soon and restart the recheck backoff. */
  noteActivity(adapter: DaemonPtyAdapter): void {
    this.recheckDelays.delete(adapter)
    this.rechecks.delete(adapter)
    this.schedule(adapter)
  }

  /** A spawn this generation's own fence refused: ask it again now, since only an answer reopens it. */
  async askAgain(adapter: DaemonPtyAdapter): Promise<void> {
    if (!this.decisions.has(adapter) && adapter.isIdleRetirementAdmissionClosed()) {
      const pending = this.timers.get(adapter)
      if (pending !== undefined) {
        clearTimeout(pending)
        this.timers.delete(adapter)
      }
      this.rechecks.delete(adapter)
      await this.check(adapter)
    }
    // Deferred behind other reattaches, or behind a check already running.
    if (
      !this.decisions.has(adapter) &&
      (this.waitingForQuiet.has(adapter) || this.checking.has(adapter))
    ) {
      await this.decisionStart(adapter)
    }
    await this.decisions.get(adapter)
  }

  /** Bounded: a decision that never starts leaves the spawn refused, as before. */
  private decisionStart(adapter: DaemonPtyAdapter): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.decisionWaiters.get(adapter) ?? new Set<() => void>()
      this.decisionWaiters.set(adapter, waiters)
      const done = (): void => {
        clearTimeout(timer)
        waiters.delete(done)
        if (waiters.size === 0 && this.decisionWaiters.get(adapter) === waiters) {
          this.decisionWaiters.delete(adapter)
        }
        resolve()
      }
      const timer = setTimeout(done, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
      timer.unref?.()
      waiters.add(done)
    })
  }

  /** The decision being asked of this generation, if any. */
  pendingDecision(adapter: DaemonPtyAdapter): Promise<unknown> | undefined {
    return this.decisions.get(adapter)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    for (const waiters of this.decisionWaiters.values()) {
      waiters.forEach((done) => done())
    }
    this.decisionWaiters.clear()
    this.waitingForQuiet.clear()
    this.checkAgain.clear()
  }

  private schedule(
    adapter: DaemonPtyAdapter,
    delayMs = this.options.timing?.exitSettleMs ?? EXIT_SETTLE_MS
  ): void {
    if (this.disposed || !this.options.applies(adapter)) {
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

  private async check(adapter: DaemonPtyAdapter): Promise<void> {
    if (this.disposed || !this.options.applies(adapter)) {
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
      this.retired(adapter)
      return
    }
    // A terminal this app still watches keeps it busy; that terminal's own exit checks again.
    if (adapter.hasWatchedSessions() && !adapter.isIdleRetirementAdmissionClosed()) {
      return
    }
    this.checking.add(adapter)
    try {
      await this.retireIfEmpty(adapter)
    } catch (error) {
      // A decision whose answer was lost is settled once the generation is proven gone.
      if (
        adapter.isIdleRetirementAdmissionClosed() &&
        (await adapter.confirmRetiredWhenIdle()) === 'retired'
      ) {
        this.retired(adapter)
        return
      }
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
    const rechecks = this.rechecks.get(adapter) ?? 0
    // A fenced generation past the limit is asked again by the next spawn it refuses (`askAgain`).
    if (rechecks >= RECHECK_LIMIT) {
      return
    }
    this.rechecks.set(adapter, rechecks + 1)
    const delayMs = this.recheckDelays.get(adapter) ?? this.options.timing?.recheckMs ?? RECHECK_MS
    this.recheckDelays.set(
      adapter,
      Math.min(delayMs * 2, this.options.timing?.recheckMaxMs ?? RECHECK_MAX_MS)
    )
    this.schedule(adapter, delayMs)
  }

  private retired(adapter: DaemonPtyAdapter): void {
    this.recheckDelays.delete(adapter)
    this.options.retired(adapter)
  }

  private async retireIfEmpty(adapter: DaemonPtyAdapter): Promise<void> {
    const epoch = this.reattachEpoch
    const { sessions, liveRelays } = await adapter.listSessionsAndRelays()
    if (this.disposed || !this.options.applies(adapter)) {
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
    this.fences.set(fence, adapter)
    const fenceTimer = setTimeout(() => {
      this.fences.delete(fence)
      releaseFence()
    }, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
    fenceTimer.unref?.()
    const decision = adapter.requestIdleRetirement()
    this.decisions.set(adapter, decision)
    this.decisionWaiters.get(adapter)?.forEach((done) => done())
    this.decisionWaiters.delete(adapter)
    try {
      const result = await decision
      if (result.state === 'retiring' && !this.disposed) {
        this.retired(adapter)
      } else if (!this.disposed && result.state === 'busy') {
        this.checkAgainLater(adapter)
      } else if (!this.disposed && result.state === 'unverifiable') {
        // Unanswered proves nothing (another client may have given it work); asking again soon also reopens it.
        if (this.recheckDelays.has(adapter)) {
          this.checkAgainLater(adapter)
        } else {
          this.recheckDelays.set(adapter, this.options.timing?.recheckMs ?? RECHECK_MS)
          this.schedule(adapter, this.options.timing?.fenceMaxMs ?? DECISION_FENCE_MAX_MS)
        }
      }
    } finally {
      this.decisions.delete(adapter)
      clearTimeout(fenceTimer)
      this.fences.delete(fence)
      releaseFence()
    }
  }
}
