// Read eligibility after ownership recovery commits so startup uses the resolver’s current lease.

import {
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionRefusalDetailsByCode,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire-refusals'
import { terminalOwnerRefusalMessage } from '../../../shared/agent-session-legacy-handoff-lease'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import { hostCanStartRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumeOperationId,
  structuredAgentSessionResumeParams
} from './structured-agent-session-resume-eligibility'

export function structuredAgentSessionStartParams(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined
):
  | Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
  | {
      ok: true
      params: NonNullable<ReturnType<typeof structuredAgentSessionResumeParams>>
      startupOptions?: Readonly<Record<string, string>>
    } {
  let record
  try {
    record = context.deps.store.requireWritableRecord(sessionId)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return { ok: false, refusal: error.refusal }
    }
    throw error
  }
  if (!record) {
    return refusedStructuredAgentSessionStart(
      'agent_session_identity_required',
      { reason: 'recordMissing' },
      'No structured session exists by that id.'
    )
  }
  if (!hostCanStartRecord(context.deps, record)) {
    return refusedStructuredAgentSessionStart(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      'This execution host cannot resume the requested structured agent session.'
    )
  }
  const params = structuredAgentSessionResumeParams(
    record,
    structuredAgentSessionResumeOperationId(context.now()),
    context.sessions.get(sessionId)?.lastEndedChild
  )
  if (!params) {
    return record.lease.unreconciled
      ? refusedStructuredAgentSessionStart(
          'execution_owner_reconciling',
          { reason: 'hostReconciling' },
          'This host has not yet adjudicated the session lease.'
        )
      : record.lease.claimStatus === 'conflicted'
        ? refusedStructuredAgentSessionStart(
            'agent_session_conflict',
            { reason: 'claimConflicted' },
            terminalOwnerRefusalMessage(record.lease)
          )
        : refusedStructuredAgentSessionStart(
            'agent_session_ownership_unknown',
            { reason: 'notResumable' },
            'The session lease is not one this host may resume.'
          )
  }
  const startupOptions = startedFor
    ? context.sessions
        .get(sessionId)
        ?.journal.submissions()
        .find((submission) => submission.clientMessageId === startedFor)?.options
    : undefined
  return { ok: true, params, ...(startupOptions ? { startupOptions } : {}) }
}

export function refusedStructuredAgentSessionStart<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string
): Extract<StructuredAgentSessionResumeOutcome, { ok: false }> {
  return { ok: false, refusal: refuse(code, details, message) }
}
