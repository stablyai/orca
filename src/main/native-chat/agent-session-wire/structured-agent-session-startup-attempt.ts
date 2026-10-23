// The host owns start policy; expiry rechecks its current child before ending a stale attempt.

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
  /** The id the host registered the start under, before any of its waits. */
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

/** Where an expired attempt stood: still spawning, or published as a starting child. */
export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  /** Null while spawn has not returned. */
  child: StructuredAgentSessionProviderChildIdentity | null
}

/** How one spawned start ended, for tuning the limits from what agents really take. */
export type StructuredAgentSessionStartupSettled = {
  agent: AgentSessionJournalIdentity['agent']
  outcome: 'ready' | 'ceiling' | 'ended'
  /** From spawn to the outcome. */
  durationMs: number
}

/** What the host learns about a start while spawn runs. */
export type StructuredAgentSessionStartupProgress = {
  /** The process exists: its start is measured from here. */
  spawned: () => void
}

type Tracked = {
  attemptId: string
  /** Null until the start reaches its acquire. */
  attempt: StructuredAgentSessionStartupAttempt | null
  child: StructuredAgentSessionProviderChildIdentity | null
  /** The ceiling counts from here: the start's registration, before any of its waits. */
  registeredAt: number
  spawnedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
  /** The limit's measure, held until an aborted spawn settles: one that is ready anyway
   *  reports that instead. */
  expiry: StructuredAgentSessionStartupSettled | null
  readiness: PromiseWithResolvers<'ready' | 'ended'>
}

/** Each session's open attempt and its startup clock. A session starts one child at a time, so a
 *  new attempt replaces any older one. */
export class StructuredAgentSessionStartupAttempts {
  private readonly open = new Map<string, Tracked>()
  private disposed = false
  private readonly limits: StructuredAgentSessionStartupLimits
  private readonly now: () => number

  constructor(
    private readonly deps: {
      /** Runs outside the session's queue: spawn or open may hold it through the handshake. */
      expire: (expired: StructuredAgentSessionExpiredStartup) => void
      /** Never throws back into the clock. */
      settled?: (settled: StructuredAgentSessionStartupSettled) => void
      limits?: Partial<StructuredAgentSessionStartupLimits>
      /** Real elapsed time: the host's own `now` may be pinned. */
      now?: () => number
    }
  ) {
    this.limits = { ...STRUCTURED_AGENT_SESSION_STARTUP_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  /** A start registered before its first wait: its ceiling runs from now. */
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

  /** Capture the attempt while the selected child still holds the session's queue. */
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

  /** The acquire returned: its `starting` child stays on the clock until it proves its start, and
   *  one published after the limit passed is expired now. */
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
    // A child published without a spawn report has existed since at least now.
    this.markSpawned(tracked)
  }

  /** Whether `child`'s start is still on its clock: false once its limit passed, so a `started`
   *  that lost the race to the limit is never accepted. */
  onClock(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const tracked = this.open.get(sessionId)
    return (
      !this.disposed &&
      !!tracked?.child &&
      !tracked.expired &&
      sameProviderChild(tracked.child, child)
    )
  }

  /** The child proved its start: its attempt is over. A stale child's proof ends nothing. */
  ready(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      this.settle(sessionId, tracked, 'ready')
    }
  }

  /** The child ended (exit, crash, Stop, close): nothing is left for its attempt to time. */
  childEnded(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** The attempt failed, or its attach did: nothing it started is left to time out. A published
   *  child stays on its clock until it proves its start or ends. */
  abandon(sessionId: string, attemptId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attemptId === attemptId && !tracked.child) {
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** Whether the session still has an attempt open; for tests and diagnostics. */
  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }

  /** Quit: no limit fires after this. */
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
    // A start's clock must never be the reason a process stays alive at quit.
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

  /** `reason` null: a start whose limit already passed inside spawn was published now. */
  private expire(sessionId: string, tracked: Tracked, reason: 'ceiling' | null): void {
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    if (reason) {
      tracked.expiry = this.measure(tracked, reason)
    }
    tracked.expired = true
    // A published child's stop is under way and ends nothing a newer attempt owns; one still
    // spawning stays tracked until its aborted spawn is abandoned or published.
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
      // Measurement is bookkeeping: it never decides a start.
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
