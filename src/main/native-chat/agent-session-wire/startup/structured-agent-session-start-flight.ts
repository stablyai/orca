// Register before waits, then probe/spawn outside serialization so sends and Stop remain responsive.
// Recheck current-flight identity at every commit; close late children without handing them input.

import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/concurrency/abort-signal-reason'
import type { StructuredAgentSessionAttachLock } from '../acquisition/structured-agent-session-attach-lock'
import type { StructuredAgentSessionEndedEvent } from '../providers/structured-agent-session-adapter'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import type { StructuredAgentSessionProviderChildIdentity } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'

export type StructuredAgentSessionStartFlight = {
  readonly abort: () => void
  readonly attemptId: string
  signal?: AbortSignal
  children?: StructuredAgentSessionProviderChildIdentity[]
  /** Settles once the logical start is ready, refused, or aborted. */
  readonly outcome: Promise<StructuredAgentSessionResumeOutcome>
}

export class StructuredAgentSessionStartFlights {
  constructor(private readonly workChanged?: (sessionId: string) => void) {}
  private readonly flying = new Map<string, StructuredAgentSessionStartFlight>()
  /** Buffer exits before child publication. */
  private readonly exits = new Map<string, StructuredAgentSessionEndedEvent[]>()
  /** Attempts still unwinding: a decided start's provider work may still be acquiring. */
  private readonly attempts = new Map<string, Set<Promise<unknown>>>()
  /** The ceiling of a session's latest cut attempt still unwinding. */
  private readonly ceilings = new Map<string, Promise<void>>()

  /** A cut attempt whose acquire is still out: past its ceiling, it never finished starting. */
  unwinding(sessionId: string, ceiling: Promise<void>): void {
    this.ceilings.set(sessionId, ceiling)
  }

  /** Settles once that ceiling has passed; never while no cut attempt is unwinding. */
  ceilingPassed(sessionId: string): Promise<void> {
    return this.ceilings.get(sessionId) ?? new Promise(() => {})
  }

  trackAttempt(sessionId: string, attempt: Promise<unknown>): void {
    const live = this.attempts.get(sessionId) ?? new Set()
    live.add(attempt)
    this.attempts.set(sessionId, live)
    const done = (): void => {
      live.delete(attempt)
      if (live.size === 0 && this.attempts.get(sessionId) === live) {
        this.attempts.delete(sessionId)
        this.ceilings.delete(sessionId)
      }
    }
    void attempt.then(done, done)
  }

  /** An attempt, though perhaps already decided, has not finished its provider work. */
  attempting(sessionId: string): boolean {
    return (this.attempts.get(sessionId)?.size ?? 0) > 0
  }

  /** Settles once every attempt for the session, including its acquisition cleanup, has ended. */
  async attemptsEnded(sessionId: string): Promise<void> {
    while (this.attempts.get(sessionId)?.size) {
      await Promise.allSettled(this.attempts.get(sessionId)!)
    }
  }

  get(sessionId: string): StructuredAgentSessionStartFlight | undefined {
    return this.flying.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.flying.has(sessionId)
  }

  /** Distinct sessions among `loaded` and those still starting, which have no indexed child yet. */
  countWith(loaded: readonly string[]): number {
    return new Set([...loaded, ...this.flying.keys()]).size
  }

  isCurrent(sessionId: string, attemptId: string): boolean {
    return this.flying.get(sessionId)?.attemptId === attemptId
  }

  register(sessionId: string, flight: StructuredAgentSessionStartFlight): void {
    this.flying.set(sessionId, flight)
    this.workChanged?.(sessionId)
  }

  published(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const flight = this.get(sessionId)
    if (flight && !this.ownsChild(sessionId, child)) {
      ;(flight.children ??= []).push({ generation: child.generation, fence: child.fence })
    }
  }

  ownsChild(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    return this.get(sessionId)?.children?.some((owned) => sameProviderChild(owned, child)) === true
  }

  projectsStarting(sessionId: string): boolean {
    const flight = this.get(sessionId)
    return !!flight?.children?.length && !flight.signal?.aborted
  }

  end(sessionId: string, attemptId: string): void {
    if (this.isCurrent(sessionId, attemptId)) {
      this.flying.delete(sessionId)
      this.exits.delete(sessionId)
      this.workChanged?.(sessionId)
    }
  }

  deferExit(event: StructuredAgentSessionEndedEvent): boolean {
    if (!this.flying.has(event.sessionId)) {
      return false
    }
    this.exits.set(event.sessionId, [...(this.exits.get(event.sessionId) ?? []), event])
    return true
  }

  takeExit(
    sessionId: string,
    child: { generation: string | null; fence: number }
  ): StructuredAgentSessionEndedEvent | undefined {
    const exits = this.exits.get(sessionId) ?? []
    this.exits.delete(sessionId)
    return exits.find(
      (exit) => exit.fence === child.fence && exit.acquisitionGeneration === child.generation
    )
  }
}

export class StructuredAgentSessionLateStartError extends Error {
  constructor() {
    super('the agent start was superseded before it committed')
    this.name = 'StructuredAgentSessionLateStartError'
  }
}

/** Authorize commits only for the currently registered start. */
export function structuredAgentSessionStartFlightLock(input: {
  sessionId: string
  attemptId: string
  signal: AbortSignal
  flights: StructuredAgentSessionStartFlights
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionAttachLock {
  const { sessionId, attemptId, signal } = input
  return {
    signal,
    wait: (work) => waitForPromiseWithSignal(work, signal),
    commit: (step) =>
      input.serialize(sessionId, async () => {
        throwIfSignalAborted(signal)
        if (!input.flights.isCurrent(sessionId, attemptId)) {
          throw new StructuredAgentSessionLateStartError()
        }
        return step()
      })
  }
}
