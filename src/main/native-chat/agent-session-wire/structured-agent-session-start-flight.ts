import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { refuse, refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
// A session's agent start in flight, outside its serialize.
//
// The serialize is where messages are admitted, so a start that held it for its probes, resolvers,
// spawn and drains made every send wait for the agent. A start instead registers here, in one short
// step before its first wait; every wait after runs outside the lock, raced with the abort signal a
// Stop, close or quit reaches it by, and every write is a commit that first re-checks the start is
// still the session's. A start that loses that check is late: what it spawned is closed, never
// handed anything.

import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt-contract'
import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'

export type StructuredAgentSessionStartFlight = {
  readonly abort: () => void
  readonly attemptId: string
  readonly outcome: Promise<StructuredAgentSessionResumeOutcome>
}

export class StructuredAgentSessionStartFlights {
  private readonly flying = new Map<string, StructuredAgentSessionStartFlight>()
  /** Buffer exits before child publication. */
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

/** Register under serialize; retain the caller's result while joiners observe readiness. */
export function registerStructuredAgentSessionStart<T>(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  run: (lock: StructuredAgentSessionAttachLock, attemptId: string) => Promise<T>,
  readiness: (result: T, signal: AbortSignal) => StructuredAgentSessionResumeOutcome
): Promise<T> {
  const { runtimeState } = context
  const attemptId = randomUUID()
  const acquire = runtimeState.acquireAborts.begin(sessionId)
  const lock = structuredAgentSessionStartFlightLock({
    sessionId,
    attemptId,
    signal: acquire.signal,
    flights: runtimeState.startFlights,
    serialize: context.serialize
  })
  const result = context.tasks.trackAttach(
    Promise.resolve()
      .then(() => run(lock, attemptId))
      .finally(() => {
        acquire.end()
        runtimeState.startFlights.end(sessionId, attemptId)
        runtimeState.startupAttempts.abandon(sessionId, attemptId)
      })
  )
  const outcome = result
    .then((value) => readiness(value, acquire.signal))
    .catch((error: unknown) => {
      if (!acquire.signal.aborted) {
        throw error
      }
      return {
        ok: false as const,
        ...(isStructuredAgentSessionStartupExpired(acquire.signal.reason)
          ? { expired: true as const }
          : { aborted: true as const }),
        refusal: refuseUnclassified(
          'agent_session_owner_restart_failed',
          agentSessionWriteNoticeEnglish(['restartFailed'])
        )
      }
    })
  // The raw caller may be the only waiter; its rejected result remains its own.
  void outcome.catch(() => undefined)
  runtimeState.startFlights.register(sessionId, { attemptId, outcome, abort: acquire.abort })
  return result
}

export async function joinStructuredAgentSessionAttach(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  run: (
    lock?: StructuredAgentSessionAttachLock,
    attemptId?: string
  ) => Promise<AgentSessionMutationResult<AgentSessionAttachResult>>
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId

  for (;;) {
    const selected = await context.serialize(sessionId, async () => {
      const child = context.sessions.get(sessionId)?.child
      const flight = context.runtimeState.startFlights.get(sessionId)
      // The owning flight alone publishes its acquisition; replay waits outside its lane.
      if (!child && flight) {
        return { flight }
      }
      const record = context.deps.store.getRecord(sessionId)
      if (!child && record && agentSessionLeaseAdmitsWriter(record.lease)) {
        return {
          result: {
            ok: false as const,
            refusal: refuse(
              'agent_session_ownership_unknown',
              { reason: 'noProviderChild' },
              'The session has no provider child to write to.'
            )
          }
        }
      }
      const replay =
        context.deps.store.getOperationRow(callerKey, params.envelope.clientOperationId)?.outcome
          .status === 'succeeded'
      if (child || replay) {
        return {
          result: await run()
        }
      }
      return {
        pending: registerStructuredAgentSessionStart(context, sessionId, run, (result, signal) =>
          result.ok
            ? { ok: true }
            : {
                ok: false,
                refusal: result.refusal,
                ...(signal.aborted
                  ? isStructuredAgentSessionStartupExpired(signal.reason)
                    ? { expired: true as const }
                    : { aborted: true as const }
                  : {})
              }
        )
      }
    })
    if (selected.result !== undefined) {
      return selected.result
    }
    if (selected.pending) {
      return selected.pending
    }
    await selected.flight.outcome
  }
}
