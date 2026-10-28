import {
  isAgentSessionWireRefusalCode,
  refuse,
  refuseUnclassified,
  withAgentSessionRefusalFacts,
  type AgentSessionAttachResult,
  type AgentSessionMutationResult,
  type AgentSessionRefusalDetailsByCode,
  type AgentSessionWireRefusal
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
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import {
  startupAcquisitionRefusal,
  providerExitObserved,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import {
  providerExecutableMissing,
  providerLaunchFolderMissing
} from '../../provider-process/provider-executable-missing'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import { agentCliInstallationProblemOf } from '../agent-cli-installation-error'
import { agentCliInstallationFacts } from '../../../shared/agent-cli-installation-problem'
import { providerDiagnosticOf } from '../../../shared/agent-session-failure'

export type FailedAcquisitionWording = {
  record: AgentSessionRecord | null
  newSession: boolean
}

/** Use start-failure wording on the wire; raw host/provider errors stay in logs. */
function failedAcquisitionWireRefusal(
  details: AgentSessionRefusalDetailsByCode['agent_session_operation_invalid'] | undefined,
  wording: FailedAcquisitionWording,
  error: unknown
): AgentSessionWireRefusal {
  const code = 'agent_session_operation_invalid'
  const refusal = details ? refuse(code, details, code) : refuseUnclassified(code, code)
  const { reason } = structuredAgentSessionStartFailure(
    {
      refusal,
      diagnostic: providerDiagnosticOf(error),
      argumentProblem: argumentProblemOf(error),
      ...(wording.newSession ? { newSession: true as const } : {})
    },
    structuredAgentSessionFailureWordsContext(wording.record)
  )
  return { ...refusal, message: reason }
}

export function failedAcquisitionSettlement(
  error: unknown,
  wording: FailedAcquisitionWording
): {
  exitProof: AgentSessionAcquisitionExitProof
  outcome: Extract<AgentSessionOperationOutcome, { status: 'failed' }>
} {
  if (error instanceof AgentSessionAcquisitionExitUnprovenError) {
    const outcome = {
      code: 'agent_session_ownership_unknown',
      details: { reason: 'ownerUnproven' as const },
      message: error.message
    }
    return { exitProof: 'unproven', outcome: { status: 'failed', ...outcome } }
  }
  const exitProof = isAgentSessionPreSpawnError(error)
    ? 'processless'
    : error instanceof AgentSessionAcquisitionRootExitObservedError
      ? 'root-exit-observed'
      : 'exit-proven'
  const raw = error instanceof Error ? error.message : String(error)
  const details = failedAcquisitionDetails(error)
  const message =
    failedAcquisitionRefusal(error, wording)?.refusal.message ??
    // Preserve bare store codes for existing replay/routing behavior.
    (isAgentSessionWireRefusalCode(raw)
      ? raw
      : failedAcquisitionWireRefusal(details, wording, error).message)
  return {
    exitProof,
    outcome: {
      status: 'failed',
      code: 'agent_session_operation_invalid',
      ...(details ? { details } : {}),
      message
    }
  }
}

function isExitProvenAcquisitionFailure(error: unknown): error is Error {
  return (
    error instanceof AgentSessionAcquisitionRootExitObservedError ||
    error instanceof AgentSessionAcquisitionExitProvenError
  )
}

/** Only typed refusal or observed provider exit identifies cause; cleanup absence alone cannot. */
function failedAcquisitionDetails(
  error: unknown
): AgentSessionRefusalDetailsByCode['agent_session_operation_invalid'] | undefined {
  const installation = agentCliInstallationProblemOf(error)
  if (installation) {
    return { reason: 'attachFailed', ...agentCliInstallationFacts(installation) }
  }
  const argumentProblem = argumentProblemOf(error)
  if (argumentProblem) {
    return { reason: 'attachFailed', argumentProblem }
  }
  const typed = startupAcquisitionRefusal(error)
  if (typed) {
    return { reason: typed.reason, ...(typed.account ? { account: typed.account } : {}) }
  }
  if (isAgentSessionPreSpawnError(error) && error.reason) {
    return { reason: error.reason }
  }
  if (isExitProvenAcquisitionFailure(error) && providerExecutableMissing(error)) {
    return { reason: 'cliMissing' }
  }
  if (isExitProvenAcquisitionFailure(error) && providerLaunchFolderMissing(error)) {
    return { reason: 'launchFolderMissing' }
  }
  if (isExitProvenAcquisitionFailure(error) && providerExitObserved(error)) {
    return { reason: 'providerStartFailed' }
  }
  return undefined
}

/** Match replay refusal shape; null defers to store-failure classification. */
export function failedAcquisitionRefusal(
  error: unknown,
  wording: FailedAcquisitionWording
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  if (
    error instanceof AgentSessionAcquisitionRefusal ||
    isExitProvenAcquisitionFailure(error) ||
    (isAgentSessionPreSpawnError(error) &&
      (argumentProblemOf(error) || agentCliInstallationProblemOf(error)))
  ) {
    return {
      ok: false,
      refusal: failedAcquisitionWireRefusal(failedAcquisitionDetails(error), wording, error)
    }
  }
  return null
}

/** Word pre-spawn errors like their replays, retaining raw diagnostics in logs and routing codes unchanged. */
export function preSpawnFailureInWords(error: unknown, wording: FailedAcquisitionWording): unknown {
  if (!isAgentSessionPreSpawnError(error) || /^[a-z0-9_]+$/.test(error.message)) {
    return error
  }
  return new AgentSessionPreSpawnError(error, {
    message: failedAcquisitionSettlement(error, wording).outcome.message
  })
}

/** New-operation retry requires a durably failed operation. */
export function failedCreateRefusal(
  refusal: AgentSessionWireRefusal,
  status: AgentSessionOperationOutcome['status'],
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } {
  return status === 'failed' && record
    ? {
        ok: false,
        refusal: withAgentSessionRefusalFacts(refusal, {
          ownerVerdict: agentSessionLeaseOwnerVerdict(record.lease)
        })
      }
    : { ok: false, refusal }
}

/** Stamp all refusal shapes from the same durable operation verdict. */
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
