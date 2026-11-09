import {
  waitForStructuredAgentSessionStart,
  type StructuredAgentSessionStartReadiness
} from './structured-agent-session-start-readiness'

import type { StructuredAgentSessionProviderChildIdentity } from '../host/structured-agent-session-host-types'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS,
  STRUCTURED_AGENT_SESSION_STARTUP_LIMITS,
  type StructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionStartupLimits
} from './structured-agent-session-startup-attempt-contract'
import { AgentSessionStartFailure } from './structured-agent-session-start-failure'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  measureStartup,
  startupContractFailure,
  startupDue,
  trackedStartup,
  type StructuredAgentSessionExpiredStartup,
  type StructuredAgentSessionStartupProgress,
  type StructuredAgentSessionStartupSettled,
  type StructuredAgentSessionTrackedStartup
} from './structured-agent-session-startup-tracking'

import { awakeNow } from '../../../power/awake-clock'
import './structured-agent-session-startup-attempt-mint'

type Tracked = StructuredAgentSessionTrackedStartup

export class StructuredAgentSessionStartupAttempts {
  private readonly open = new Map<string, Tracked>()
  /** The open settling each starting child's outcome; while it runs, the child's end waits for it. */
  private readonly owners = new Map<string, StructuredAgentSessionProviderChildIdentity>()
  private disposed = false
  private readonly limits: StructuredAgentSessionStartupLimits
  private readonly now: () => number

  constructor(
    private readonly deps: {
      /** Expire outside serialization so blocked provider startup cannot delay cancellation. */
      expire: (expired: StructuredAgentSessionExpiredStartup) => void
      /** The adapter answered nothing within the grace after its exit; cancel like expiry. */
      breach?: (breached: StructuredAgentSessionExpiredStartup & { agent: string }) => void
      settled?: (settled: StructuredAgentSessionStartupSettled) => void
      limits?: Partial<StructuredAgentSessionStartupLimits>
      /** Use elapsed time; host clocks may be pinned. Defaults to the awake clock, so time the
       *  machine spends asleep never counts toward the ceiling. */
      now?: () => number
    }
  ) {
    this.limits = { ...STRUCTURED_AGENT_SESSION_STARTUP_LIMITS, ...deps.limits }
    this.now = deps.now ?? awakeNow
  }

  /** A start registered before its first wait: its ceiling runs from now. */
  begin(sessionId: string, attemptId: string, registeredAt = this.now()) {
    const result = this.register(sessionId, attemptId, registeredAt)
    return { ended: result.readiness.promise, result, registeredAt }
  }

  pastCeiling(registeredAt: number): boolean {
    return this.now() - registeredAt >= this.limits.ceilingMs
  }

  private register(sessionId: string, attemptId: string, registeredAt = this.now()): Tracked {
    this.end(sessionId)
    const tracked = trackedStartup(attemptId, registeredAt)
    this.open.set(sessionId, tracked)
    if (!this.disposed) {
      this.schedule(sessionId, tracked)
    }
    return tracked
  }

  track(
    sessionId: string,
    attempt: StructuredAgentSessionStartupAttempt
  ): StructuredAgentSessionStartupProgress {
    const begun = this.open.get(sessionId)
    const tracked =
      begun?.attemptId === attempt.attemptId && !begun.attempt
        ? begun
        : this.register(sessionId, attempt.attemptId)
    tracked.attempt = attempt
    tracked.stopListening ??= attempt.events?.onRootExit?.(() =>
      this.rootExited(sessionId, tracked)
    )
    const current = (): boolean => this.open.get(sessionId) === tracked && !this.disposed
    return {
      spawned: () => {
        if (current()) {
          this.markSpawned(tracked)
        }
      }
    }
  }

  /** Capture readiness while the selected child still owns serialization. */
  readiness(
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ): StructuredAgentSessionStartReadiness | null {
    const tracked = this.open.get(sessionId)
    if (!tracked?.child || !sameProviderChild(tracked.child, child)) {
      return null
    }
    return {
      wait: (budgetMs) => waitForStructuredAgentSessionStart(tracked.readiness.promise, budgetMs)
    }
  }

  /** The child's open claims its outcome; false if the child no longer starts on this clock. */
  own(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    if (!this.tracking(sessionId, child)) {
      return false
    }
    this.owners.set(sessionId, { generation: child.generation, fence: child.fence })
    return true
  }

  disown(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    if (this.ownsOpen(sessionId, child)) {
      this.owners.delete(sessionId)
    }
  }

  ownsOpen(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const owner = this.owners.get(sessionId)
    return !!owner && sameProviderChild(owner, child)
  }

  /** The owner's verdict; readiness waiters and the start flight read it once readiness ends. */
  failed(
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity,
    failure: AgentSessionStartFailure
  ): void {
    const tracked = this.tracking(sessionId, child)
    if (tracked) {
      tracked.failure = failure
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** Published starts retain their clock; expire immediately if acquisition outlasted its limit. */
  published(
    sessionId: string,
    attemptId: string,
    child: StructuredAgentSessionProviderChildIdentity & { phase?: 'starting' | 'ready' }
  ): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attemptId !== attemptId) {
      return
    }
    tracked.child = { generation: child.generation, fence: child.fence }
    if (child.phase === 'ready') {
      this.settle(sessionId, tracked, 'ready')
      return
    }
    if (tracked.expired) {
      this.expire(sessionId, tracked, null)
      return
    }
    this.markSpawned(tracked)
  }

  /** Reject readiness that lost the race to expiry. */
  onClock(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const tracked = this.tracking(sessionId, child)
    return !this.disposed && !!tracked && !tracked.expired
  }

  ready(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      this.settle(sessionId, tracked, 'ready')
    }
  }

  /** Settles once the adapter saw this starting child's own root exit; otherwise never. */
  rootExit(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): Promise<void> {
    return this.tracking(sessionId, child)?.rootExit.promise ?? new Promise(() => {})
  }

  /** Orca ending the child decides the start: a failure Orca recorded is final, any other close
   *  cancels it. An exit of its own leaves an open still settling the start, and its clock, until
   *  that open gives the outcome. */
  childEnded(
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity,
    ended: { byOrca: boolean; failure?: SubmissionRejectionFact; reason?: string | null } = {
      byOrca: false
    }
  ): void {
    const tracked = this.tracking(sessionId, child)
    if (ended.failure) {
      const cause = new Error(ended.reason ?? 'Orca stopped the agent while it started')
      this.failed(sessionId, child, new AgentSessionStartFailure(cause, 'never', ended.failure))
    } else if (tracked && (ended.byOrca || !this.ownsOpen(sessionId, child))) {
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** The owner ended without a verdict: replaced, cancelled or no longer starting. */
  released(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.tracking(sessionId, child)
    if (tracked) {
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** Abandoned unpublished attempts stop timing; published children remain tracked until ready/ended. */
  abandon(sessionId: string, attemptId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attemptId === attemptId && !tracked.child) {
      this.settle(sessionId, tracked, 'ended')
    }
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }

  dispose(): void {
    this.disposed = true
    for (const tracked of this.open.values()) {
      tracked.readiness.resolve('ended')
      tracked.stopListening?.()
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.open.clear()
    this.owners.clear()
  }

  private tracking(
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ): Tracked | undefined {
    const tracked = this.open.get(sessionId)
    return tracked?.child && sameProviderChild(tracked.child, child) ? tracked : undefined
  }

  /** The deadline becomes the earlier of the original one and the grace after the exit. */
  private rootExited(sessionId: string, tracked: Tracked): void {
    if (this.open.get(sessionId) !== tracked || this.disposed || tracked.rootExitAt !== null) {
      return
    }
    tracked.rootExitAt = this.now()
    tracked.rootExit.resolve()
    if (tracked.timer) {
      clearTimeout(tracked.timer)
    }
    this.schedule(sessionId, tracked)
  }

  private markSpawned(tracked: Tracked): void {
    tracked.spawnedAt ??= this.now()
  }

  private schedule(sessionId: string, tracked: Tracked): void {
    const due = startupDue(tracked, this.limits.ceilingMs)
    tracked.timer = setTimeout(() => this.check(sessionId, tracked), Math.max(0, due - this.now()))
    tracked.timer.unref?.()
  }

  private check(sessionId: string, tracked: Tracked): void {
    tracked.timer = null
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    if (this.now() - tracked.registeredAt >= this.limits.ceilingMs) {
      this.expire(sessionId, tracked, 'ceiling')
    } else if (
      tracked.rootExitAt !== null &&
      this.now() - tracked.rootExitAt >= STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS
    ) {
      this.breach(sessionId, tracked)
    } else {
      this.schedule(sessionId, tracked)
    }
  }

  /** Fires on a timer, so neither the adapter nor the session's serialized work can hold it. */
  private breach(sessionId: string, tracked: Tracked): void {
    const agent = tracked.attempt?.identity.agent ?? 'agent'
    tracked.failure = startupContractFailure(agent)
    const breached = { sessionId, attemptId: tracked.attemptId, child: tracked.child, agent }
    this.settle(sessionId, tracked, 'ended')
    this.deps.breach?.(breached)
  }

  /** null means an already-expired spawn just published its child. */
  private expire(sessionId: string, tracked: Tracked, reason: 'ceiling' | null): void {
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    if (reason) {
      tracked.expiry = this.measure(tracked, reason)
    }
    tracked.expired = true
    // Published children stop independently; spawning attempts remain tracked until cleanup/publication.
    if (tracked.child) {
      this.report(tracked.expiry)
      this.end(sessionId)
    }
    this.deps.expire({ sessionId, attemptId: tracked.attemptId, child: tracked.child })
  }

  private settle(sessionId: string, tracked: Tracked, outcome: 'ready' | 'ended'): void {
    tracked.readiness.resolve(outcome)
    this.report(
      tracked.expired && outcome === 'ended' ? tracked.expiry : this.measure(tracked, outcome)
    )
    this.end(sessionId)
  }

  private measure(
    tracked: Tracked,
    outcome: StructuredAgentSessionStartupSettled['outcome']
  ): StructuredAgentSessionStartupSettled | null {
    return measureStartup(tracked, outcome, this.now())
  }

  private report(settled: StructuredAgentSessionStartupSettled | null): void {
    if (!settled || this.disposed) {
      return
    }
    try {
      this.deps.settled?.(settled)
    } catch {
      // Measurement must never decide startup.
    }
  }

  private end(sessionId: string): void {
    const tracked = this.open.get(sessionId)
    tracked?.readiness.resolve('ended')
    tracked?.stopListening?.()
    if (tracked?.timer) {
      clearTimeout(tracked.timer)
    }
    this.open.delete(sessionId)
  }
}
