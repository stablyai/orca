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
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { runSettledAgentSessionMutation } from './structured-agent-session-operation-settlement'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

export const AGENT_SESSION_NOT_ATTACHED: AgentSessionWireRefusal = {
  code: 'agent_session_ownership_unknown',
  message: 'This host holds no attached session by that id.'
}

export function refuseAgentSessionMutation(refusal: AgentSessionWireRefusal): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return { ok: false, refusal }
}

export type AgentSessionMutationRequest<TValue> = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  /** Journal of the attached session; absent when this host holds none. */
  journal: AgentSessionJournal | undefined
  publish: (journal: AgentSessionJournal) => void
  now: () => number
}

export async function admitAndRunAgentSessionMutation<TValue>(
  request: AgentSessionMutationRequest<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, plan, journal } = request
  const record = request.store.getRecord(envelope.sessionId)
  if (!journal || !record) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const conflict = agentSessionFingerprintConflict(envelope, hostFingerprint)
  if (conflict) {
    return refuseAgentSessionMutation(conflict)
  }
  const admission = admitAgentSessionMutation({
    envelope,
    hostFingerprint,
    ledger: await request.store.admitOperation({
      callerKey: request.callerKey,
      operationId: envelope.clientOperationId,
      fingerprint: hostFingerprint,
      now: request.now()
    }),
    lease: record.lease
  })
  if (admission.decision === 'refused') {
    return refuseAgentSessionMutation(admission.refusal)
  }

  const fence = record.lease.runtimeFence
  const context = turnContext(request, journal, fence)
  if (admission.decision === 'replay') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: envelope.clientOperationId,
      outcome: admission.row.outcome,
      reconstruct: () => plan.replay(context, admission.row.outcome),
      rerunWhenReplayMissing: plan.rerunWhenReplayMissing?.(context)
    })
    if (replay.decision === 'refuse') {
      return refuseAgentSessionMutation(replay.refusal)
    }
    if (replay.decision === 'replay') {
      return { ok: true, replayed: true, fence, cursor: journal.cursor(), value: replay.value }
    }
    // Nothing durable landed, so this id is about to run for the first time. A
    // refused call leaves its ledger row behind, and replaying past the lease and
    // the fence would let a resend act under an owner that has since changed — so
    // a first run pays the full admission price either way.
    const rerun = admitAgentSessionMutation({
      envelope,
      hostFingerprint,
      ledger: { decision: 'admit', row: admission.row },
      lease: record.lease
    })
    if (rerun.decision === 'refused') {
      return refuseAgentSessionMutation(rerun.refusal)
    }
  }

  plan.beforeRun?.()
  const outcome = await runSettledAgentSessionMutation({
    store: request.store,
    callerKey: request.callerKey,
    envelope,
    plan,
    context
  })
  return outcome.ok
    ? { ok: true, replayed: false, fence, cursor: journal.cursor(), value: outcome.value }
    : refuseAgentSessionMutation(outcome.refusal)
}

function turnContext<TValue>(
  request: AgentSessionMutationRequest<TValue>,
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
    now: () => request.now()
  }
}
