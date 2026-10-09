import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-adapter'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-provider-exit-proof'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionStopVerdict } from './structured-agent-session-host-types'
import { endProviderChild } from './structured-agent-session-provider-child'

export async function settlePostAcquisitionAttachFailure(
  input: AttachFlowInput,
  record: AgentSessionRecord,
  cause: unknown
): Promise<never> {
  let cleanupError: unknown = cause
  let exitProof: 'exit-proven' | 'root-exit-observed' | 'unproven' = 'unproven'
  try {
    await rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, cause)
  } catch (error) {
    cleanupError = error
    exitProof =
      error instanceof AgentSessionAcquisitionExitUnprovenError
        ? 'unproven'
        : error instanceof AgentSessionAcquisitionRootExitObservedError
          ? 'root-exit-observed'
          : 'exit-proven'
  }
  input.onAcquisitionReleased?.(cause, { rootGone: exitProof !== 'unproven' })
  try {
    await input.store.settleFailedPostAcquisitionAttachment({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken: record.lease.reservedSpawnToken ?? '',
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'agent_session_operation_invalid',
        details: { reason: 'attachFailed' },
        message: cause instanceof Error ? cause.message : String(cause)
      },
      exitProof,
      now: input.now()
    })
  } catch (settlementError) {
    throw new AggregateError(
      [cleanupError, settlementError],
      'agent session post-acquisition attachment failure settlement failed'
    )
  }
  throw cleanupError
}

export function endStructuredAgentSessionReleasedChild(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  cause: unknown,
  verdict: StructuredAgentSessionStopVerdict
): void {
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (child) {
    context.runtimeState.startupAttempts.childEnded(sessionId, child)
  }
  if (
    !session ||
    !child ||
    !endProviderChild(session, {
      generation: child.generation,
      fence: child.fence,
      cause: 'attach-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
      // Orca failed to attach; the provider said nothing.
      failure: agentSessionFailureFact('hostFault'),
      duringStartup: child.phase === 'starting',
      ...verdict
    })
  ) {
    return
  }
  context.runtimeState.currentEventSink(sessionId)?.close()
  context.runtimeState.discardEventSink(sessionId)
  context.publishStatus?.(sessionId)
}
