// A session's agent start in flight, outside its serialize.
//
// The serialize is where messages are admitted, so a start that held it for its probes, resolvers,
// spawn and drains made every send wait for the agent. A start instead registers here, in one short
// step before its first wait; every wait after runs outside the lock, raced with the abort signal a
// Stop, close or quit reaches it by, and every write is a commit that first re-checks the start is
// still the session's. A start that loses that check is late: what it spawned is closed, never
// handed anything.

import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'

export type StructuredAgentSessionStartFlight = {
  /** The start's generation: the startup attempt it mints carries the same id. */
  readonly abort: () => void
  readonly attemptId: string
  /** Settles once the start is over: its child published, refused, or aborted. */
  readonly outcome: Promise<StructuredAgentSessionResumeOutcome>
}

/** One start per session: a second asker joins the one in flight. */
export class StructuredAgentSessionStartFlights {
  private readonly flying = new Map<string, StructuredAgentSessionStartFlight>()
  /** Exits reported for a start's child before its publish put it on record. */
  private readonly exits = new Map<string, StructuredAgentSessionEndedEvent[]>()

  get(sessionId: string): StructuredAgentSessionStartFlight | undefined {
    return this.flying.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.flying.has(sessionId)
  }

  isCurrent(sessionId: string, attemptId: string): boolean {
    return this.flying.get(sessionId)?.attemptId === attemptId
  }

  register(sessionId: string, flight: StructuredAgentSessionStartFlight): void {
    this.flying.set(sessionId, flight)
  }

  end(sessionId: string, attemptId: string): void {
    if (this.isCurrent(sessionId, attemptId)) {
      this.flying.delete(sessionId)
      this.exits.delete(sessionId)
    }
  }

  /** Held for the publish when a start is in flight; false when none is. */
  deferExit(event: StructuredAgentSessionEndedEvent): boolean {
    if (!this.flying.has(event.sessionId)) {
      return false
    }
    this.exits.set(event.sessionId, [...(this.exits.get(event.sessionId) ?? []), event])
    return true
  }

  /** The exit reported for the child a start is publishing, if any. */
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

/** The start was not the session's by the time it committed: its result is discarded. */
export class StructuredAgentSessionLateStartError extends Error {
  constructor() {
    super('the agent start was superseded before it committed')
    this.name = 'StructuredAgentSessionLateStartError'
  }
}

/** The lock a start runs its attach under; its fence is the start's own registration. */
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
        // A close of the conversation, like a Stop or quit, aborts the start first.
        throwIfSignalAborted(signal)
        if (!input.flights.isCurrent(sessionId, attemptId)) {
          throw new StructuredAgentSessionLateStartError()
        }
        return step()
      })
  }
}
