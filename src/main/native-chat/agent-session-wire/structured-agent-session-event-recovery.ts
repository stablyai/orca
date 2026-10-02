import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionLifecycleEvent } from './structured-agent-session-adapter'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import { settleStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import { settleUnexpectedStructuredAgentSessionExit } from './structured-agent-session-unexpected-exit'
import {
  finishOwedStructuredAgentSessionWindDownUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import {
  recordUnprovenStructuredAgentSessionEnd,
  recordUnprovenStructuredAgentSessionEndUnderSerialize
} from './structured-agent-session-unproven-end'

type StructuredAgentSessionEventRecoveryContext = {
  deps: StructuredAgentSessionHostDeps
  store: StructuredAgentSessionHostDeps['store']
  sessions: Map<string, StructuredAgentSessionHostSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishFence: (sessionId: string, session: StructuredAgentSessionHostSession) => void
  publishStatus?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Resolved per call: the host's collaborators are assigned after this is built. */
  lifetime: () => StructuredAgentSessionLifetimeContext
}

export class StructuredAgentSessionEventRecovery {
  private readonly sinkFailures = new Set<string>()
  private readonly context: StructuredAgentSessionEventRecoveryContext & {
    now: () => number
    wakeDelivery: (sessionId: string) => void
    /** Retries the stop owed for the session's child; for a caller inside its serialize. */
    finishOwedWindDown: (sessionId: string) => Promise<boolean>
  }

  constructor(context: StructuredAgentSessionEventRecoveryContext) {
    this.context = {
      ...context,
      now: () => context.lifetime().now(),
      wakeDelivery: (sessionId) => context.lifetime().wakeDelivery?.(sessionId),
      finishOwedWindDown: (sessionId) =>
        finishOwedStructuredAgentSessionWindDownUnderSerialize(context.lifetime(), sessionId)
    }
  }

  private get exitContext() {
    return { ...this.context, logger: this.context.deps.logger }
  }

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
        const stopped = await stopAgentSessionProviderRoot(() => stop(sessionId)).catch(
          (stopError: unknown) => {
            this.context.deps.logger.warn(
              'stopping a provider after its journal failed did not prove its exit',
              {
                scope: 'sink-failure-recovery',
                sessionId,
                error: stopError
              }
            )
            return false
          }
        )
        const reason = `journal sink failure: ${error instanceof Error ? error.message : String(error)}`
        if (!stopped) {
          // The child may still run: it stays, and its stop is owed, never forgotten.
          recordUnprovenStructuredAgentSessionEndUnderSerialize(this.context, sessionId, child, {
            reason,
            failure: agentSessionFailureFact('hostFault')
          })
          return null
        }
        if (!acquisitionGeneration) {
          return null
        }
        return {
          type: 'ended',
          sessionId,
          reason,
          // Orca stopped the provider because its own journal failed.
          failure: agentSessionFailureFact('hostFault'),
          cause: 'unexpected-exit',
          fence,
          acquisitionGeneration
        } as const
      })
      .then((event) => (event ? this.handle(event) : undefined))
      .catch((error: unknown) =>
        this.context.deps.logger.warn(
          'stopping a provider after its journal failed did not finish',
          {
            scope: 'sink-failure-recovery',
            sessionId,
            error
          }
        )
      )
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  /** An exit is settled and shown; nothing restarts the child. The next send does, through the
   *  delivery loop, which also owns any message still queued. */
  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    if (event.type === 'started') {
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    if (event.type === 'end-unproven') {
      return recordUnprovenStructuredAgentSessionEnd(this.context, event)
    }
    await settleUnexpectedStructuredAgentSessionExit(this.exitContext, event)
  }
}
