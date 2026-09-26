import {
  stopAgentSessionProviderRoot,
  type StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { endProviderChild } from './structured-agent-session-provider-child'
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
        const reason = `journal sink failure: ${error instanceof Error ? error.message : String(error)}`
        const stopped = await stopAgentSessionProviderRoot(() => stop(sessionId))
        if (!stopped) {
          await this.endUnprovenChild(sessionId, child, reason)
          return null
        }
        if (!acquisitionGeneration) {
          return null
        }
        return {
          type: 'ended',
          sessionId,
          reason,
          cause: 'unexpected-exit',
          fence,
          acquisitionGeneration
        } as const
      })
      .then((event) => (event ? this.handle(event) : undefined))
      .catch((recoveryError) => this.context.onBarrierError(sessionId, recoveryError))
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  /** The force-close could not prove the exit, but the child is closing and takes no writes: it
   *  ends here, and its lease goes to recovery. */
  private async endUnprovenChild(
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    reason: string
  ): Promise<void> {
    const session = this.context.sessions.get(sessionId)
    if (
      !session ||
      !endProviderChild(session, {
        generation: child.generation,
        fence: child.fence,
        cause: 'host-stop',
        reason,
        duringStartup: child.phase === 'starting',
        rootGone: false
      })
    ) {
      return
    }
    try {
      await releaseStoredStructuredAgentSessionOwner({
        store: this.context.store,
        sessionId,
        hasProviderChild: true,
        expectedFence: child.fence,
        now: this.context.now(),
        rootGone: false
      })
    } finally {
      this.context.publishStatus?.(sessionId)
    }
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
