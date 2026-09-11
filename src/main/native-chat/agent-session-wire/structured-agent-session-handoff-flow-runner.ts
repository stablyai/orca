import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { stopStructuredNativeTurn } from './structured-agent-session-handoff-flow-context'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import type { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import { assertScheduledStructuredHandoffIsAdmissible } from './structured-agent-session-handoff-revalidation'
import { handoffStructuredSessionToNative } from './structured-agent-session-handoff-reverse'
import { structuredTuiStatus } from './structured-agent-session-handoff-status'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext
} from './structured-agent-session-handoff-types'

export class StructuredAgentSessionHandoffFlowRunner {
  private readonly active = new Set<Promise<void>>()

  constructor(
    private readonly input: {
      deps: StructuredAgentSessionHandoffDeps
      operationGuard: StructuredAgentSessionHandoffOperationGuard
      flowContext: () => StructuredAgentSessionHandoffFlowContext
      fail: (params: AgentSessionHandoffRequest, error: unknown) => void
    }
  ) {}

  async drain(): Promise<void> {
    await Promise.allSettled(this.active)
  }

  track(task: Promise<void>): void {
    this.active.add(task)
    // Settle-only bookkeeping. `.finally` forwards a rejection onto a promise nobody awaits, so a
    // failure notification that threw escaped as an unhandled rejection even though `drain` — the
    // one consumer — settles the flow through `allSettled`.
    const forget = (): void => void this.active.delete(task)
    void task.then(forget, forget)
  }

  begin(input: {
    callerKey: string
    params: AgentSessionHandoffRequest
    turnId: string | null
    fingerprint: string
    tuiAlreadyExited?: boolean
  }): void {
    const { callerKey, params, turnId, fingerprint, tuiAlreadyExited = false } = input
    const sessionId = params.envelope.sessionId
    const journalSequence = this.input.deps.session(sessionId).journal.cursor().sequence
    this.input.operationGuard.start(sessionId, {
      callerKey,
      operationId: params.envelope.clientOperationId,
      fingerprint
    })
    const flow = this.run(params, turnId, tuiAlreadyExited, journalSequence)
      .then(() => {
        this.input.operationGuard.finish(sessionId, params.envelope.clientOperationId)
        return this.input.deps.store.recordOperationOutcome({
          callerKey,
          operationId: params.envelope.clientOperationId,
          outcome: { status: 'succeeded', sessionId }
        })
      })
      .catch(async (error) => {
        try {
          await this.input.deps.store.recordOperationOutcome({
            callerKey,
            operationId: params.envelope.clientOperationId,
            outcome: { status: 'failed', code: 'agent_session_handoff_failed' }
          })
        } catch {
          // Best-effort: a store write failure must not suppress the client's failure
          // notification or leak the flow as an unhandled rejection.
        }
        this.input.operationGuard.finish(sessionId, params.envelope.clientOperationId)
        this.input.fail(params, error)
      })
      .finally(() => this.input.operationGuard.finish(sessionId, params.envelope.clientOperationId))
    this.track(flow)
  }

  private run(
    params: AgentSessionHandoffRequest,
    turnId: string | null,
    tuiAlreadyExited: boolean,
    journalSequence: number
  ): Promise<void> {
    const sessionId = params.envelope.sessionId
    return this.input.deps.schedule(sessionId, async () => {
      const context = this.input.flowContext()
      assertScheduledStructuredHandoffIsAdmissible({
        record: context.requireRecord(sessionId),
        journal: this.input.deps.session(sessionId).journal,
        params,
        turnId,
        journalSequence,
        tuiAlreadyExited,
        tuiStatus: structuredTuiStatus(context.owner(sessionId), this.input.deps.transport)
      })
      if (turnId && params.mode === 'stop-turn') {
        const stopped = await stopStructuredNativeTurn(this.input.deps, sessionId, turnId)
        if (!stopped) {
          throw new Error('The current turn did not acknowledge cancellation.')
        }
      }
      await (params.direction === 'to-tui'
        ? handoffStructuredSessionToTui(context, params, params.action === 'retry')
        : handoffStructuredSessionToNative(
            context,
            params,
            params.action === 'retry',
            tuiAlreadyExited
          ))
    })
  }
}
