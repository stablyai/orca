import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'

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
  // A failed close must not prevent durable failure settlement.
  await Promise.resolve(input.onAttachFailed?.()).catch(() => undefined)
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
