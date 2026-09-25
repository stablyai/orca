import {
  stopAgentSessionProviderRoot,
  type StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import { settleStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import { settleUnexpectedStructuredAgentSessionExit } from './structured-agent-session-unexpected-exit'

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
          cause: 'unexpected-exit',
          fence,
          acquisitionGeneration
        } as const
      })
      .then((event) => (event ? this.handle(event) : undefined))
      .catch((recoveryError) => this.context.onBarrierError(sessionId, recoveryError))
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  /** An exit is settled and shown; nothing restarts the child. The next send does, through the
   *  delivery loop, which also owns any message still queued. */
  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    if (event.type === 'started') {
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    await settleUnexpectedStructuredAgentSessionExit(this.context, event)
  }
}
