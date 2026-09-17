// The one route every mutating agent-session call takes: recompute the
// fingerprint, admit through the durable operation ledger, check the lease, then
// run the plan. It lives outside the host so that no method can quietly grow its
// own admission rules by sitting next to the call site.

import {
  admitAgentSessionMutation,
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_UNATTACHED_REFUSAL_CODE } from '../../../shared/structured-agent-session-read-refusal'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { runSettledAgentSessionMutation } from './structured-agent-session-operation-settlement'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

// The code is shared with the client so a read that refuses this way can be told apart from a
// transcript that failed to load; the two must never drift apart.
export const AGENT_SESSION_NOT_ATTACHED: AgentSessionWireRefusal = {
  code: AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  message: 'This host holds no attached session by that id.'
}

export function refuseAgentSessionMutation(refusal: AgentSessionWireRefusal): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return { ok: false, refusal }
}

type AgentSessionMutationAdmissionPlan<TValue> = Pick<
  MutationPlan<TValue>,
  | 'method'
  | 'fields'
  | 'operationIdScope'
  | 'replay'
  | 'rerunWhenReplayMissing'
  | 'recoverUnknownFromDurableState'
>

export type AgentSessionMutationAdmissionRequest<TValue> = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: AgentSessionMutationAdmissionPlan<TValue>
  /** Journal of the attached session; absent when this host holds none. */
  journal: AgentSessionJournal | undefined
  publish: (journal: AgentSessionJournal) => void
  flushStreamedEvents: (sessionId: string) => Promise<void>
  now: () => number
}

export type AgentSessionMutationRequest<TValue> = Omit<
  AgentSessionMutationAdmissionRequest<TValue>,
  'plan'
> & { plan: MutationPlan<TValue> }

export type AgentSessionMutationAdmission<TValue> =
  | { decision: 'return'; result: AgentSessionMutationResult<TValue> }
  | {
      decision: 'run'
      context: AgentSessionTurnContext
      operationCallerKey: string
    }

/** Admit a mutation without running it. Long-running host work uses this split so the session queue
 *  protects durable admission without remaining held across a provider round trip. */
export async function admitAgentSessionMutationRequest<TValue>(
  request: AgentSessionMutationAdmissionRequest<TValue>
): Promise<AgentSessionMutationAdmission<TValue>> {
  const { envelope, plan, journal } = request
  if (!journal) {
    return { decision: 'return', result: refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED) }
  }
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const conflict = agentSessionFingerprintConflict(envelope, hostFingerprint)
  if (conflict) {
    return { decision: 'return', result: refuseAgentSessionMutation(conflict) }
  }
  const admitted = await request.store.admitMutationOperation({
    callerKey: request.callerKey,
    envelope,
    hostFingerprint,
    now: request.now(),
    ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
  })
  if (!admitted) {
    return { decision: 'return', result: refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED) }
  }
  const { admission, record } = admitted
  if (admission.decision === 'refused') {
    return { decision: 'return', result: refuseAgentSessionMutation(admission.refusal) }
  }

  const fence = record.lease.runtimeFence
  const context = turnContext(request, journal, fence)
  if (admission.decision === 'replay') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: envelope.clientOperationId,
      outcome: admission.row.outcome,
      reconstruct: () => plan.replay(context, admission.row.outcome),
      rerunWhenReplayMissing: plan.rerunWhenReplayMissing?.(context),
      recoverUnknownFromDurableState: plan.recoverUnknownFromDurableState
    })
    if (replay.decision === 'refuse') {
      return { decision: 'return', result: refuseAgentSessionMutation(replay.refusal) }
    }
    if (replay.decision === 'replay') {
      return {
        decision: 'return',
        result: { ok: true, replayed: true, fence, cursor: journal.cursor(), value: replay.value }
      }
    }
    const rerun = admitAgentSessionMutation({
      envelope,
      hostFingerprint,
      ledger: { decision: 'admit', row: admission.row },
      lease: record.lease
    })
    if (rerun.decision === 'refused') {
      return { decision: 'return', result: refuseAgentSessionMutation(rerun.refusal) }
    }
  }
  return { decision: 'run', context, operationCallerKey: admission.row.callerKey }
}

export async function admitAndRunAgentSessionMutation<TValue>(
  request: AgentSessionMutationRequest<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  const admitted = await admitAgentSessionMutationRequest(request)
  if (admitted.decision === 'return') {
    return admitted.result
  }

  const outcome = await runSettledAgentSessionMutation({
    store: request.store,
    // A global send replay can cross caller identities. Settlement still owns
    // the durable row admitted by the original caller.
    operationCallerKey: admitted.operationCallerKey,
    envelope: request.envelope,
    plan: request.plan,
    context: admitted.context
  })
  return outcome.ok
    ? {
        ok: true,
        replayed: false,
        fence: admitted.context.fence,
        cursor: admitted.context.journal.cursor(),
        value: outcome.value
      }
    : refuseAgentSessionMutation(outcome.refusal)
}

function turnContext<TValue>(
  request: AgentSessionMutationAdmissionRequest<TValue>,
  journal: AgentSessionJournal,
  fence: number
): AgentSessionTurnContext {
  const persistedOptions = request.store.getRecord(request.envelope.sessionId)?.options
  return {
    sessionId: request.envelope.sessionId,
    journal,
    fence,
    adapter: request.adapter,
    ...(persistedOptions ? { persistedOptions } : {}),
    persistOptions: (options) =>
      request.store
        .replaceSessionOptions({
          sessionId: request.envelope.sessionId,
          fence,
          options,
          now: request.now()
        })
        .then(() => undefined),
    resolvedBy: request.callerKey,
    publish: () => request.publish(journal),
    flushStreamedEvents: () => request.flushStreamedEvents(request.envelope.sessionId),
    now: () => request.now()
  }
}
