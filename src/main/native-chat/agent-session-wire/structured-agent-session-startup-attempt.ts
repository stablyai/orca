import { randomUUID } from 'node:crypto'
import {
  waitForStructuredAgentSessionStart,
  type StructuredAgentSessionStartReadiness
} from './structured-agent-session-start-readiness'
export type { StructuredAgentSessionStartReadiness } from './structured-agent-session-start-readiness'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_LIMITS,
  type StructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionStartupLimits
} from './structured-agent-session-startup-attempt-contract'

export function mintStructuredAgentSessionStartupAttempt(input: {
  record: AgentSessionRecord
  identity: AgentSessionJournalIdentity
  spawnToken: string
  permissionMode?: AgentChatPermissionMode
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  startupOptions?: Readonly<Record<string, string>>
  attemptId?: string
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  const options = input.startupOptions ?? record.options
  return {
    attemptId: input.attemptId ?? randomUUID(),
    identity: input.identity,
    fence: record.lease.runtimeFence,
    spawnToken: input.spawnToken,
    launch: {
      location: record.location,
      accountHome: record.accountHome,
      ...(record.launchDirectory === undefined ? {} : { launchDirectory: record.launchDirectory })
    },
    ...(options ? { options } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  }
}

export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  child: StructuredAgentSessionProviderChildIdentity | null
}

export type StructuredAgentSessionStartupSettled = {
  agent: AgentSessionJournalIdentity['agent']
  outcome: 'ready' | 'ceiling' | 'ended'
  durationMs: number
}

export type StructuredAgentSessionStartupProgress = {
  spawned: () => void
}

type Tracked = {
  attemptId: string
  attempt: StructuredAgentSessionStartupAttempt | null
  child: StructuredAgentSessionProviderChildIdentity | null
  /** Absolute ceiling starts before any startup wait. */
  registeredAt: number
  spawnedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
  /** Defer expiry reporting until aborted spawn settles; successful readiness overrides it. */
  expiry: StructuredAgentSessionStartupSettled | null
  readiness: PromiseWithResolvers<'ready' | 'ended'>
}

export class StructuredAgentSessionStartupAttempts {
  private readonly open = new Map<string, Tracked>()
  private disposed = false
  private readonly limits: StructuredAgentSessionStartupLimits
  private readonly now: () => number

  constructor(
    private readonly deps: {
      /** Expire outside serialization so blocked provider startup cannot delay cancellation. */
      expire: (expired: StructuredAgentSessionExpiredStartup) => void
      settled?: (settled: StructuredAgentSessionStartupSettled) => void
      limits?: Partial<StructuredAgentSessionStartupLimits>
      /** Use elapsed time; host clocks may be pinned. */
      now?: () => number
    }
  ) {
    this.limits = { ...STRUCTURED_AGENT_SESSION_STARTUP_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  begin(sessionId: string, attemptId: string): void {
    this.register(sessionId, attemptId)
  }

  private register(sessionId: string, attemptId: string): Tracked {
    this.end(sessionId)
    const tracked: Tracked = {
      attemptId,
      attempt: null,
      child: null,
      registeredAt: this.now(),
      spawnedAt: null,
      timer: null,
      expired: false,
      expiry: null,
      readiness: Promise.withResolvers()
    }
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
    if (child.phase === 'ready') {
      this.settle(sessionId, tracked, 'ready')
      return
    }
    tracked.child = { generation: child.generation, fence: child.fence }
    if (tracked.expired) {
      this.expire(sessionId, tracked, null)
      return
    }
    this.markSpawned(tracked)
  }

  /** Reject readiness that lost the race to expiry. */
  onClock(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const tracked = this.open.get(sessionId)
    return (
      !this.disposed &&
      !!tracked?.child &&
      !tracked.expired &&
      sameProviderChild(tracked.child, child)
    )
  }

  ready(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      this.settle(sessionId, tracked, 'ready')
    }
  }

  childEnded(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
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
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.open.clear()
  }

  private markSpawned(tracked: Tracked): void {
    tracked.spawnedAt ??= this.now()
  }

  private schedule(sessionId: string, tracked: Tracked): void {
    const due = tracked.registeredAt + this.limits.ceilingMs
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
    } else {
      this.schedule(sessionId, tracked)
    }
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
    return tracked.spawnedAt === null || !tracked.attempt
      ? null
      : {
          agent: tracked.attempt.identity.agent,
          outcome,
          durationMs: Math.max(0, this.now() - tracked.spawnedAt)
        }
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
    if (tracked?.timer) {
      clearTimeout(tracked.timer)
    }
    this.open.delete(sessionId)
  }
}
