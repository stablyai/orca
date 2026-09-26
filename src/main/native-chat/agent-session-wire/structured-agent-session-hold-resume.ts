// Giving a session its provider child back.
//
// This is the replacement for the startup resume, and the difference is only in WHO asks: the same
// eligibility rule, run when a surface binds, when a send finds the owner gone, or when a child
// exits under an open surface — never when the app launches. It runs inside the session's
// serialize, with the attach it is given, so the eligibility it reads is the one the attach acts
// on. A write-capable hold must fail when acquisition is refused so the surface never mistakes a
// readable journal for a live provider child.

import {
  isAgentSessionRefusalCause,
  isAgentSessionWireRefusalCode,
  refuse,
  type AgentSessionRefusalCause
} from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import {
  attachStructuredAgentSessionUnderSerialize,
  type StructuredAgentSessionAttachOptions
} from './structured-agent-session-attach-orchestration'
import { failedCreateRefusal } from './structured-agent-session-failed-create-refusal'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumeOperationId,
  structuredAgentSessionResumeParams
} from './structured-agent-session-resume-eligibility'

/** A resume answers with the attach's own refusal, verdict and all, so the asker can tell a lease
 *  someone else is settling from an owner that will not come back. */
export type StructuredAgentSessionResumeOutcome =
  | { ok: true }
  | { ok: false; refusal: AgentSessionWireRefusal }

export async function resumeHeldStructuredAgentSession(input: {
  sessionId: string
  context: StructuredAgentSessionAttachContext
  /** Who is asking; the attach keys the ledger row it settles by it. */
  callerKey: string
  attachOptions?: StructuredAgentSessionAttachOptions
}): Promise<StructuredAgentSessionResumeOutcome> {
  const { sessionId, context, callerKey } = input
  // The record is read only once this host has adjudicated it and exited any recovery stage a
  // failed attempt latched — a lease left in `manual-recovery` by an unproven exit is one the
  // resolver hands back, and the eligibility below must see it that way.
  const unreconciled = await context.reconcileLeases(sessionId)
  if (unreconciled) {
    return { ok: false, refusal: unreconciled }
  }
  await context.runtimeState.resolveRecovery(sessionId)
  const record = context.deps.store.getRecord(sessionId)
  if (!record) {
    return refuseResume(
      'agent_session_identity_required',
      'recordMissing',
      'No structured session exists by that id.'
    )
  }
  if (!adapterSupportsRecord(context.deps.adapter, record)) {
    return refuseResume(
      'structured_agent_session_unsupported',
      'hostUnsupported',
      'This execution host cannot resume the requested structured agent session.'
    )
  }
  const params = structuredAgentSessionResumeParams(
    record,
    structuredAgentSessionResumeOperationId(context.now())
  )
  if (!params) {
    return record.lease.unreconciled
      ? refuseResume(
          'execution_owner_reconciling',
          'hostReconciling',
          'This host has not yet adjudicated the session lease.'
        )
      : record.lease.claimStatus === 'conflicted'
        ? refuseResume(
            'agent_session_conflict',
            'claimConflicted',
            'Another process claims this session.'
          )
        : refuseResume(
            'agent_session_ownership_unknown',
            'notResumable',
            'The session lease is not one this host may resume.'
          )
  }
  let attached: AgentSessionMutationResult<AgentSessionAttachResult>
  try {
    attached = await attachStructuredAgentSessionUnderSerialize(
      context,
      callerKey,
      params,
      input.attachOptions
    )
  } catch (error) {
    // The attach settles an acquisition that failed — the ledger row, the released lease — before
    // it rethrows the cause. That row is the answer: a failure it recorded is this resume's
    // refusal, verdict and all. Only an error it did not record is a fault for the caller.
    const settled = settledResumeRefusal(
      context,
      callerKey,
      params.envelope.clientOperationId,
      sessionId,
      error
    )
    if (settled) {
      return settled
    }
    throw error
  }
  return attached.ok ? { ok: true } : { ok: false, refusal: attached.refusal }
}

function settledResumeRefusal(
  context: Pick<StructuredAgentSessionAttachContext, 'deps'>,
  callerKey: string,
  operationId: string,
  sessionId: string,
  error: unknown
): StructuredAgentSessionResumeOutcome | null {
  const outcome = context.deps.store.getOperationRow(callerKey, operationId)?.outcome
  if (outcome?.status !== 'failed' || !isAgentSessionWireRefusalCode(outcome.code)) {
    return null
  }
  return failedCreateRefusal(
    {
      code: outcome.code,
      ...(isAgentSessionRefusalCause(outcome.cause) ? { cause: outcome.cause } : {}),
      message: outcome.message ?? (error instanceof Error ? error.message : String(error))
    },
    outcome.status,
    context.deps.store.getRecord(sessionId)
  )
}

function refuseResume(
  code: AgentSessionWireRefusal['code'],
  cause: AgentSessionRefusalCause,
  message: string
): StructuredAgentSessionResumeOutcome {
  return { ok: false, refusal: refuse(code, cause, message) }
}
