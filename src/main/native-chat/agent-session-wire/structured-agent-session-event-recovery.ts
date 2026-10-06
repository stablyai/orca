import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionLifecycleEvent } from './structured-agent-session-adapter'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import { settleStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import {
  endExitedStructuredAgentSessionChildUnderSerialize,
  settleStructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExitContext
} from './structured-agent-session-child-exit'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

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
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      now: () => number
      runtimeState: StructuredAgentSessionHostRuntimeState
      wakeDelivery: (sessionId: string) => void
    }
  ) {}

  private get exitContext(): StructuredAgentSessionChildExitContext {
    const { deps, runtimeState } = this.context
    return {
      ...this.context,
      logger: deps.logger,
      route: {
        runtimeState,
        acknowledgeRelease: (sessionId) => deps.adapter.acknowledgeSessionRelease?.(sessionId)
      }
    }
  }

  /** The one exit handler, for a caller inside the session's serialize that proved the exit. */
  endExitedChildUnderSerialize = (
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    exit: StructuredAgentSessionChildExit
  ): Promise<void> =>
    endExitedStructuredAgentSessionChildUnderSerialize(this.exitContext, sessionId, child, exit)

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
        const stopped =
          child && stop ? await stopAgentSessionProviderRoot(() => stop(sessionId)) : 'unproven'
        if (!child || stopped === 'unproven') {
          return
        }
        // Ended in the same step as the stop, so no report of that close can end it first as a
        // quiet rest: Orca stopped the provider because its own journal failed.
        await this.endExitedChildUnderSerialize(sessionId, child, {
          expected: false,
          reason: `journal sink failure: ${error instanceof Error ? error.message : String(error)}`,
          failure: agentSessionFailureFact('hostFault'),
          ...(stopped === 'killed' ? { rootExitUnobserved: true as const } : {})
        })
      })
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

  /** Every child's exit ends its record here, expected or not. An exit is settled and shown;
   *  nothing restarts the child. The next send does, through the delivery loop, which also owns any
   *  message still queued. */
  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    if (event.type === 'started') {
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    await settleStructuredAgentSessionChildExit(this.exitContext, event)
  }
}
