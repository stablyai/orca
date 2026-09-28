import {
  stopAgentSessionProviderRoot,
  type StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { endProviderChild } from './structured-agent-session-provider-child'
import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
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
      /** What the stop's own wind-down runs against. */
      lifetime: () => StructuredAgentSessionLifetimeContext
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
   *  ends here, and the stop's own wind-down settles it and hands its lease to recovery. Owed
   *  first, so a release that fails is retried by the next Stop, close or quit. */
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
    session.owesProviderChildWindDown = { generation: child.generation, fence: child.fence }
    this.context.publishStatus?.(sessionId)
    await stopStructuredAgentSessionAgentUnderSerialize(this.context.lifetime(), sessionId, {
      cause: 'host-stop',
      reason
    })
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
