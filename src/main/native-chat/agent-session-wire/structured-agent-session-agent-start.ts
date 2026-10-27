// Only queued work or provider operations start children. Run waits outside serialization;
// fence each state commit so concurrent sends remain immediately acceptable.

import {
  providerDiagnosticOf,
  type SubmissionRejectionFact,
  type AgentSessionArgumentProblem,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  readAgentSessionRefusalReference
} from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { attachStructuredAgentSessionForStart } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import {
  failedStructuredAgentSessionStart,
  registerStructuredAgentSessionStart,
  structuredAgentSessionStartStillQueued
} from './structured-agent-session-start-attempts'
import { retryableStructuredAgentSessionAcquisition } from './structured-agent-session-start-retry'
import { failedCreateRefusal } from './structured-agent-session-failed-create-refusal'
import {
  joinClosingStructuredAgentSessionChild,
  releaseLeaseOfEndedStructuredAgentSessionChild
} from './structured-agent-session-child-close'
export { joinClosingStructuredAgentSessionChild }
import {
  refusedStructuredAgentSessionStart,
  structuredAgentSessionStartParams
} from './structured-agent-session-start-eligibility'

/** Preserve attach refusal verdicts so callers distinguish recovery in progress from permanent loss. */
export type StructuredAgentSessionResumeOutcome =
  | { ok: true }
  | {
      ok: false
      refusal: AgentSessionWireRefusal
      /** Provider diagnostic is host-only, never part of the refusal. */
      diagnostic?: ProviderDiagnostic
      /** Host cancellation must not fail work the start was serving. */
      aborted?: true
      /** Startup silence/ceiling expiry means Orca stopped the start. */
      expired?: true
      argumentProblem?: AgentSessionArgumentProblem
      retry?: boolean
      failure?: SubmissionRejectionFact
      startKey?: string | null
    }

const AGENT_START_CALLER_KEY = 'trusted-local:agent-start'

export type StructuredAgentSessionStartClaim = {
  outcome: Promise<StructuredAgentSessionResumeOutcome>
}

/** Claim under the ordered decision; wait outside its lane. */
export function claimStructuredAgentSessionAgent(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor?: string
): StructuredAgentSessionStartClaim {
  try {
    context.deps.store.requireWritableRecord(sessionId)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return { outcome: Promise.resolve({ ok: false, refusal: error.refusal }) }
    }
    throw error
  }
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (!structuredAgentSessionStartStillQueued(session, startedFor)) {
    return { outcome: Promise.resolve({ ...failedStructuredAgentSessionStart(), aborted: true }) }
  }
  const flight = context.runtimeState.startFlights.get(sessionId)
  if (flight) {
    return { outcome: flight.outcome }
  }
  if (child && !child.close) {
    return { outcome: Promise.resolve({ ok: true }) }
  }
  return {
    outcome: registerStructuredAgentSessionStart(
      context,
      sessionId,
      startedFor,
      (lock, attemptId) => runStart(context, sessionId, startedFor, lock, attemptId)
    )
  }
}

export async function startStructuredAgentSessionAgent(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor?: string
): Promise<StructuredAgentSessionResumeOutcome> {
  const claim = await context.serialize(sessionId, async () =>
    claimStructuredAgentSessionAgent(context, sessionId, startedFor)
  )
  return claim.outcome
}

export function startStructuredAgentSessionAgentForOperation(
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<StructuredAgentSessionResumeOutcome> {
  return context
    .serialize(sessionId, async () => claimOperationStart(context, sessionId))
    .then((claim) => claim.outcome)
}

export function claimOperationStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): StructuredAgentSessionStartClaim {
  const claim = claimStructuredAgentSessionAgent(context, sessionId)
  return {
    outcome: claim.outcome.catch((error: unknown) => {
      context.deps.logger.warn('starting the agent for an operation failed', {
        scope: 'operation-agent-start',
        sessionId,
        error
      })
      return failedStructuredAgentSessionStart()
    })
  }
}

async function runStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined,
  lock: StructuredAgentSessionAttachLock,
  attemptId: string
): Promise<StructuredAgentSessionResumeOutcome> {
  // Never start beside a closing child; unverifiable exit refuses the restart.
  const closed = await joinClosingStructuredAgentSessionChild(context, sessionId, lock)
  if (!closed.ok) {
    return closed
  }
  const callerKey = AGENT_START_CALLER_KEY
  // Read eligibility only after lease adjudication/recovery; each commits against its probed owner.
  const unreconciled = await lock.wait(context.reconcileLeases(sessionId))
  if (unreconciled) {
    return { ok: false, refusal: unreconciled }
  }
  await lock.wait(context.runtimeState.resolveRecovery(sessionId))
  const eligible = await lock.commit(async () => {
    // Re-derive release from this host’s exit proof when wind-down could not persist it.
    await releaseLeaseOfEndedStructuredAgentSessionChild(context, sessionId)
    return structuredAgentSessionStartParams(context, sessionId, startedFor)
  })
  if (!eligible.ok) {
    return eligible
  }
  const { params, startupOptions } = eligible
  let attached: AgentSessionMutationResult<AgentSessionAttachResult>
  let acquisitionError: unknown
  let aborted = false
  let expired = false
  let published = false
  try {
    attached = await attachStructuredAgentSessionForStart(context, callerKey, params, {
      lock,
      startupAttemptId: attemptId,
      ...(startedFor === undefined ? {} : { startedFor }),
      ...(startupOptions ? { startupOptions } : {}),
      onAcquisitionFailed: (error) => {
        acquisitionError = error
      },
      onAborted: () => {
        aborted = true
      },
      onStartupExpired: () => {
        expired = true
      },
      onPublished: () => {
        published = true
      }
    })
  } catch (error) {
    // Attach records refusal before rethrowing; only unrecorded errors remain caller faults.
    const settled = settledResumeRefusal(
      context,
      callerKey,
      params.envelope.clientOperationId,
      sessionId,
      error
    )
    if (settled) {
      return withDiagnostic(settled.refusal, error, { aborted, expired })
    }
    throw error
  }
  if (!attached.ok) {
    return withDiagnostic(attached.refusal, acquisitionError, { aborted, expired })
  }
  return published
    ? { ok: true }
    : refusedStructuredAgentSessionStart(
        'agent_session_ownership_unknown',
        { reason: 'noProviderChild' },
        'The session attached without a provider child to write to.'
      )
}

function withDiagnostic(
  refusal: AgentSessionWireRefusal,
  error: unknown,
  { aborted, expired }: { aborted: boolean; expired: boolean }
): StructuredAgentSessionResumeOutcome {
  const diagnostic = providerDiagnosticOf(error)
  const argumentProblem = argumentProblemOf(error)
  return {
    ok: false,
    refusal,
    ...(diagnostic ? { diagnostic } : {}),
    ...(aborted ? { aborted: true as const } : {}),
    ...(expired ? { expired: true as const } : {}),
    ...(argumentProblem ? { argumentProblem } : {}),
    retry: retryableStructuredAgentSessionAcquisition(error)
  }
}

function settledResumeRefusal(
  context: Pick<StructuredAgentSessionAttachContext, 'deps'>,
  callerKey: string,
  operationId: string,
  sessionId: string,
  error: unknown
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const outcome = context.deps.store.getOperationRow(callerKey, operationId)?.outcome
  const reference =
    outcome?.status === 'failed'
      ? readAgentSessionRefusalReference({ code: outcome.code, details: outcome.details })
      : undefined
  if (outcome?.status !== 'failed' || !reference) {
    return null
  }
  return failedCreateRefusal(
    agentSessionRefusalFromReference(
      reference,
      outcome.message ?? (error instanceof Error ? error.message : String(error))
    ),
    outcome.status,
    context.deps.store.getRecord(sessionId)
  )
}
