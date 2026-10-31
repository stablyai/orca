// Register before waits, then probe/spawn outside serialization so sends and Stop remain responsive.
// Recheck current-flight identity at every commit; close late children without handing them input.

import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

export type StructuredAgentSessionStartFlight = {
  readonly abort: () => void
  readonly attemptId: string
  signal?: AbortSignal
  children?: StructuredAgentSessionProviderChildIdentity[]
  /** Settles once the logical start is ready, refused, or aborted. */
  readonly outcome: Promise<StructuredAgentSessionResumeOutcome>
}

export class StructuredAgentSessionStartFlights {
  private readonly flying = new Map<string, StructuredAgentSessionStartFlight>()
  /** Buffer exits before child publication. */
  private readonly exits = new Map<string, StructuredAgentSessionEndedEvent[]>()
  private readonly physical = new Map<string, { owners: Set<Promise<void>>; covered: boolean }>()

  observePhysicalExit(sessionId: string, exited: Promise<void>, priorRootProven: boolean): void {
    let history = this.physical.get(sessionId)
    if (!history) {
      history = { owners: new Set(), covered: priorRootProven }
      this.physical.set(sessionId, history)
    }
    const owners = history.owners
    owners.add(exited)
    const captured = owners
    void exited.then(
      () => captured.delete(exited),
      () => {}
    )
  }

  /** Empty coverage survives handle eviction; completed process graphs do not. */
  physicalExit(sessionId: string, retiredWithoutRoot: boolean) {
    return {
      wait: (signal?: AbortSignal): Promise<void> => {
        throwIfSignalAborted(signal)
        const history = this.physical.get(sessionId)
        if (history ? !history.covered : retiredWithoutRoot) {
          throw agentSessionRefusalError('agent_session_ownership_unknown', {
            reason: 'ownerUnproven'
          })
        }
        // Rejoin the live set after each exact exit; expired callers detach from this observer.
        const pending = history?.owners.values().next().value
        return pending ? waitForPromiseWithSignal(pending, signal) : Promise.resolve()
      },
      current: (): boolean => {
        const history = this.physical.get(sessionId)
        return history ? history.covered && history.owners.size === 0 : !retiredWithoutRoot
      }
    }
  }

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
