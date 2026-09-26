import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  stopAgentSessionProviderRoot,
  type StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import { settleStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import {
  isStructuredAgentSessionRecoveryTicketCurrent,
  settleUnexpectedStructuredAgentSessionExit
} from './structured-agent-session-unexpected-exit'

export class StructuredAgentSessionEventRecovery {
  private readonly sinkFailures = new Set<string>()

  constructor(
    private readonly context: {
      deps: StructuredAgentSessionHostDeps
      store: StructuredAgentSessionHostDeps['store']
      sessions: Map<string, StructuredAgentSessionHostSession>
      flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
      publishFence: (sessionId: string, session: StructuredAgentSessionHostSession) => void
      publishStatus?: (sessionId: string) => void
      hasResumeCapableHolder: (sessionId: string) => boolean
      restartReleaseGrace: (sessionId: string) => void
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      now: () => number
      /** The one restart every asker shares; the holds put an unheld child on the idle clock. */
      ensureProviderChild: StructuredAgentSessionHolds['ensureProviderChild']
      onBarrierError: (sessionId: string, error: unknown) => void
    }
  ) {}

  recoverAfterSinkFailure(sessionId: string, error: unknown): void {
    if (this.sinkFailures.has(sessionId)) {
      return
    }
    this.sinkFailures.add(sessionId)
    void this.context
      .serialize(sessionId, async () => {
        const child = this.context.sessions.get(sessionId)?.child
        const stop =
          this.context.deps.adapter.forceCloseSession ?? this.context.deps.adapter.closeSession
        if (!child || !stop) {
          return null
        }
        const { fence, generation: acquisitionGeneration } = child
        const stopped = await stopAgentSessionProviderRoot(() => stop(sessionId))
        if (!stopped || !acquisitionGeneration) {
          return null
        }
        return {
          type: 'ended',
          sessionId,
          reason: `journal sink failure: ${error instanceof Error ? error.message : String(error)}`,
          // Orca stopped the provider because its own journal failed.
          failure: agentSessionFailureFact('hostFault'),
          cause: 'unexpected-exit',
          fence,
          acquisitionGeneration
        } as const
      })
      .then((event) => (event ? this.handle(event) : undefined))
      .catch((recoveryError) => this.context.onBarrierError(sessionId, recoveryError))
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    if (event.type === 'started') {
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    const ticket = await settleUnexpectedStructuredAgentSessionExit(this.context, event)
    if (!ticket) {
      return
    }
    // One serialized step with the ticket check inside it: a hold or a send that got there first
    // has already replaced the owner, and this step finds that child and attaches nothing — or,
    // once the lease has moved on, refuses on the stale ticket rather than spawning a second child.
    try {
      const resumed = await this.context.serialize(ticket.sessionId, () =>
        this.context.ensureProviderChild(ticket.sessionId, {
          admitRecoveryTicket: () =>
            isStructuredAgentSessionRecoveryTicketCurrent(this.context, ticket)
        })
      )
      if (!resumed.ok && isStructuredAgentSessionRecoveryTicketCurrent(this.context, ticket)) {
        this.context.onBarrierError(
          ticket.sessionId,
          new Error(`${resumed.refusal.code}: ${resumed.refusal.message}`)
        )
      }
    } catch (error) {
      if (isStructuredAgentSessionRecoveryTicketCurrent(this.context, ticket)) {
        this.context.onBarrierError(ticket.sessionId, error)
      }
    }
  }
}
