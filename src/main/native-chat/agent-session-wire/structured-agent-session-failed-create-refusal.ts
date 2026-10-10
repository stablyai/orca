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
  providerExitObserved,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { providerExecutableMissing } from '../../provider-process/provider-executable-missing'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import { providerDiagnosticOf } from '../../../shared/agent-session-failure'

/** Who a failed acquisition's sentence names, and whether it was the session's first start. */
export type FailedAcquisitionWording = {
  record: AgentSessionRecord | null
  newSession: boolean
}

/** The refusal a failed acquisition answers with, worded as the start failure it records: its
 *  error text is Orca's or the provider's log wording, so it goes to the log, never the wire. */
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

/** What a failed acquisition proved about its process, and the outcome its operation settles to. */
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
    // A store refusal's message is its code, which its replay has always carried.
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

/** Cleanup proved the child gone after the start failed, whatever failed it. */
function isExitProvenAcquisitionFailure(error: unknown): error is Error {
  return (
    error instanceof AgentSessionAcquisitionRootExitObservedError ||
    error instanceof AgentSessionAcquisitionExitProvenError
  )
}

/** The situation a failed acquisition stands for: what the adapter typed, or a provider the
 *  adapter saw exit while starting. A provider refusing a request, a timeout, a store refusal or
 *  Orca's own fault names none: the child being gone now says nothing about why. */
function failedAcquisitionDetails(
  error: unknown
): AgentSessionRefusalDetailsByCode['agent_session_operation_invalid'] | undefined {
  const argumentProblem = argumentProblemOf(error)
  if (argumentProblem) {
    return { reason: 'attachFailed', argumentProblem }
  }
  if (error instanceof AgentSessionAcquisitionRefusal) {
    return { reason: error.reason, ...(error.account ? { account: error.account } : {}) }
  }
  if (isAgentSessionPreSpawnError(error) && error.reason) {
    return { reason: error.reason }
  }
  if (isExitProvenAcquisitionFailure(error) && providerExecutableMissing(error)) {
    return { reason: 'cliMissing' }
  }
  if (isExitProvenAcquisitionFailure(error) && providerExitObserved(error)) {
    return { reason: 'providerStartFailed' }
  }
  return undefined
}

/** A failed acquisition answered as a refusal on the first call, in the shape its replay takes;
 *  null leaves the error to the store-failure classification. */
export function failedAcquisitionRefusal(
  error: unknown,
  wording: FailedAcquisitionWording
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  // A proven exit is a settled failure, answered in the shape its ledger row replays.
  if (
    error instanceof AgentSessionAcquisitionRefusal ||
    isExitProvenAcquisitionFailure(error) ||
    (isAgentSessionPreSpawnError(error) && argumentProblemOf(error))
  ) {
    return {
      ok: false,
      refusal: failedAcquisitionWireRefusal(failedAcquisitionDetails(error), wording, error)
    }
  }
  return null
}

/** A start that failed before any process still throws, in the sentence its replay reads: the
 *  error's own text is Orca's or the refusing site's, so it goes to the log. A message that is
 *  itself a code keeps it, since the wire routes on it. */
export function preSpawnFailureInWords(error: unknown, wording: FailedAcquisitionWording): unknown {
  if (!isAgentSessionPreSpawnError(error) || /^[a-z0-9_]+$/.test(error.message)) {
    return error
  }
  return new AgentSessionPreSpawnError(error, {
    message: failedAcquisitionSettlement(error, wording).outcome.message
  })
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
        refusal: withAgentSessionRefusalFacts(refusal, {
          ownerVerdict: agentSessionLeaseOwnerVerdict(record.lease)
        })
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
