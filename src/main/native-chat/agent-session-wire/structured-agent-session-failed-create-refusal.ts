import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionOperationOutcome,
  AgentSessionOperationRow
} from '../../../shared/agent-session-operation-ledger'
import { agentSessionLeaseOwnerVerdict } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAcquisitionExitProof } from '../../runtime/agent-session-acquisition-failure-settlement'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'

/** What a failed acquisition proved about its process, and the outcome its operation settles to. */
export function failedAcquisitionSettlement(error: unknown): {
  exitProof: AgentSessionAcquisitionExitProof
  outcome: Extract<AgentSessionOperationOutcome, { status: 'failed' }>
} {
  if (error instanceof AgentSessionAcquisitionExitUnprovenError) {
    const outcome = { code: 'agent_session_ownership_unknown', message: error.message }
    return { exitProof: 'unproven', outcome: { status: 'failed', ...outcome } }
  }
  const exitProof = isAgentSessionPreSpawnError(error)
    ? 'processless'
    : error instanceof AgentSessionAcquisitionRootExitObservedError
      ? 'root-exit-observed'
      : 'exit-proven'
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error instanceof AgentSessionAcquisitionRefusal ? error.code : 'agent_session_operation_invalid'
  return { exitProof, outcome: { status: 'failed', code, message } }
}

/** A failed acquisition answered as a refusal on the first call, in the shape its replay takes;
 *  null leaves the error to the store-failure classification. */
export function failedAcquisitionRefusal(
  error: unknown
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  if (error instanceof AgentSessionAcquisitionRefusal) {
    return { ok: false, refusal: { code: error.code, message: error.message } }
  }
  // A proven exit is a settled fact; its message is the provider's own diagnostic.
  if (
    error instanceof AgentSessionAcquisitionRootExitObservedError ||
    error instanceof AgentSessionAcquisitionExitProvenError
  ) {
    return {
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: error.message }
    }
  }
  return null
}

/** Only a durably failed operation says anything about retrying under a new one. */
export function failedCreateRefusal(
  refusal: AgentSessionWireRefusal,
  status: AgentSessionOperationOutcome['status'],
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } {
  return status === 'failed' && record
    ? {
        ok: false,
        refusal: { ...refusal, ownerVerdict: agentSessionLeaseOwnerVerdict(record.lease) }
      }
    : { ok: false, refusal }
}

/** The one place a create refusal learns its verdict: from the durable row this operation
 *  settled to, so every refusal shape answers the same fact and no site can forget the stamp. */
export function stampFailedCreateOwnerVerdict(
  store: {
    getOperationRow: (callerKey: string, operationId: string) => AgentSessionOperationRow | null
    getRecord: (sessionId: string) => AgentSessionRecord | null
  },
  callerKey: string,
  envelope: { sessionId: string; clientOperationId: string },
  result: AgentSessionMutationResult<AgentSessionAttachResult>
): AgentSessionMutationResult<AgentSessionAttachResult> {
  if (result.ok) {
    return result
  }
  const row = store.getOperationRow(callerKey, envelope.clientOperationId)
  return failedCreateRefusal(
    result.refusal,
    row?.outcome.status ?? 'pending',
    store.getRecord(envelope.sessionId)
  )
}
