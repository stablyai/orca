// One start of a conversation's provider child, minted by the host before any adapter acquires.
//
// Whatever a start means as policy belongs to the host and is the same for every agent: which
// conversation and lease it is for, what cancels it, when it gives up, and when its child may take
// input. An adapter only runs its protocol inside the attempt it is handed.
//
// The clock starts when the process exists, never before (resolving a launch is not starting it).
// A start that says nothing for a minute is wedged; one still talking is given up only at the
// ceiling, so a slow migration or history replay is not killed mid-way while every start still
// ends. Expiry re-derives what to end from the host's own state, so a timer that outlives its
// attempt ends nothing.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
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
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  optionRevision: () => number
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  return {
    attemptId: randomUUID(),
    identity: input.identity,
    fence: record.lease.runtimeFence,
    spawnToken: input.spawnToken,
    launch: {
      location: record.location,
      accountHome: record.accountHome,
      ...(record.launchDirectory === undefined ? {} : { launchDirectory: record.launchDirectory })
    },
    ...(record.options ? { options: record.options } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    optionRevision: input.optionRevision
  }
}

/** The startup limit's own reason, so an expired start is told from a close, Stop or quit. */
export class StructuredAgentSessionStartupExpiredError extends Error {
  constructor() {
    super('the agent stopped making progress before it finished starting')
    this.name = 'StructuredAgentSessionStartupExpiredError'
  }
}

export function isStructuredAgentSessionStartupExpired(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'StructuredAgentSessionStartupExpiredError'
}

/** Where an expired attempt stood: still inside its acquire, or published as a starting child. */
export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  /** Null while the acquire has not returned. */
  child: StructuredAgentSessionProviderChildIdentity | null
}

/** How one spawned start ended, for tuning the limits from what agents really take. */
export type StructuredAgentSessionStartupSettled = {
  agent: AgentSessionJournalIdentity['agent']
  outcome: 'ready' | 'silent' | 'ceiling' | 'ended'
  /** From spawn to the outcome. */
  durationMs: number
}

/** What the host learns about a start while its acquire runs. */
export type StructuredAgentSessionStartupProgress = {
  /** The process exists: the clock starts. */
  spawned: () => void
  /** Any output; output before a spawn report also starts the clock. */
  output: () => void
}

type Tracked = {
  attempt: StructuredAgentSessionStartupAttempt
  child: StructuredAgentSessionProviderChildIdentity | null
  spawnedAt: number | null
  lastOutputAt: number
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
  /** The limit's measure, held until an acquire it aborted settles: one that is ready anyway
   *  reports that instead. */
  expiry: StructuredAgentSessionStartupSettled | null
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
      /** Runs outside the session's queue: an acquire may hold it for the whole handshake. */
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

  track(
    sessionId: string,
    attempt: StructuredAgentSessionStartupAttempt
  ): StructuredAgentSessionStartupProgress {
    this.end(sessionId)
    const tracked: Tracked = {
      attempt,
      child: null,
      spawnedAt: null,
      lastOutputAt: 0,
      timer: null,
      expired: false,
      expiry: null
    }
    this.open.set(sessionId, tracked)
    const current = (): boolean => this.open.get(sessionId) === tracked && !this.disposed
    return {
      spawned: () => {
        if (current()) {
          this.startClock(sessionId, tracked)
        }
      },
      output: () => {
        if (!current()) {
          return
        }
        if (tracked.spawnedAt === null) {
          this.startClock(sessionId, tracked)
          return
        }
        // Read when the timer fires, so a chatty child costs no timer churn.
        tracked.lastOutputAt = this.now()
      }
    }
  }

  /** The acquire returned: a `starting` child stays on the clock until it proves its start, and
   *  one published after the limit passed is expired now. */
  published(
    sessionId: string,
    attemptId: string,
    child: StructuredAgentSessionProviderChildIdentity & { phase: 'starting' | 'ready' }
  ): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attempt.attemptId !== attemptId) {
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
    if (tracked.spawnedAt === null && !this.disposed) {
      this.startClock(sessionId, tracked)
    }
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

  /** The attempt failed, or its attach did: nothing it started is left to time out. */
  abandon(sessionId: string, attemptId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attempt.attemptId === attemptId) {
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
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.open.clear()
  }

  private startClock(sessionId: string, tracked: Tracked): void {
    if (tracked.spawnedAt !== null) {
      return
    }
    tracked.spawnedAt = this.now()
    tracked.lastOutputAt = tracked.spawnedAt
    this.schedule(sessionId, tracked)
  }

  private schedule(sessionId: string, tracked: Tracked): void {
    if (tracked.spawnedAt === null) {
      return
    }
    const due = Math.min(
      tracked.lastOutputAt + this.limits.silenceMs,
      tracked.spawnedAt + this.limits.ceilingMs
    )
    tracked.timer = setTimeout(() => this.check(sessionId, tracked), Math.max(0, due - this.now()))
    // A start's clock must never be the reason a process stays alive at quit.
    tracked.timer.unref?.()
  }

  private check(sessionId: string, tracked: Tracked): void {
    tracked.timer = null
    if (this.open.get(sessionId) !== tracked || this.disposed || tracked.spawnedAt === null) {
      return
    }
    const now = this.now()
    if (now - tracked.spawnedAt >= this.limits.ceilingMs) {
      this.expire(sessionId, tracked, 'ceiling')
    } else if (now - tracked.lastOutputAt >= this.limits.silenceMs) {
      this.expire(sessionId, tracked, 'silent')
    } else {
      this.schedule(sessionId, tracked)
    }
  }

  /** `reason` null: a start whose limit already passed inside its acquire was published now. */
  private expire(sessionId: string, tracked: Tracked, reason: 'silent' | 'ceiling' | null): void {
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    if (reason) {
      tracked.expiry = this.measure(tracked, reason)
    }
    tracked.expired = true
    const { child } = tracked
    // A published child's stop is under way and ends nothing a newer attempt owns; one still
    // acquiring stays tracked until its aborted acquire is abandoned or published.
    if (child) {
      this.report(tracked.expiry)
      this.end(sessionId)
    }
    this.deps.expire({ sessionId, attemptId: tracked.attempt.attemptId, child })
  }

  private settle(sessionId: string, tracked: Tracked, outcome: 'ready' | 'ended'): void {
    this.report(
      tracked.expired && outcome === 'ended' ? tracked.expiry : this.measure(tracked, outcome)
    )
    this.end(sessionId)
  }

  private measure(
    tracked: Tracked,
    outcome: StructuredAgentSessionStartupSettled['outcome']
  ): StructuredAgentSessionStartupSettled | null {
    return tracked.spawnedAt === null
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
    if (tracked?.timer) {
      clearTimeout(tracked.timer)
    }
    this.open.delete(sessionId)
  }
}
