// The one route every mutating agent-session call takes: recompute the
// fingerprint, admit through the durable operation ledger, check the lease, then
// run the plan. It lives outside the host so that no method can quietly grow its
// own admission rules by sitting next to the call site.
//
// Admission is two-phase for a call that brings a `prepareSession`. The ledger's
// answer comes first and places nothing; a call it will admit may then give the
// session an owner, and only after that are the row placed and the lease
// checked — against the lease as it stands once the owner is there.

import {
  admitAgentSessionMutation,
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionOperationDecision } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { AGENT_SESSION_UNATTACHED_REFUSAL_CODE } from '../../../shared/structured-agent-session-read-refusal'
import type {
  AgentSessionMutationOperationAdmission,
  AgentSessionMutationOperationDecision
} from '../../runtime/agent-session-operation-admission'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  classifyJournalOpenFailure,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { runSettledAgentSessionMutation } from './structured-agent-session-operation-settlement'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

// The code is shared with the client so a read that refuses this way can be told apart from a
// transcript that failed to load; the two must never drift apart.
export const AGENT_SESSION_NOT_ATTACHED: AgentSessionWireRefusal = refuse(
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  { reason: 'sessionNotAttached' },
  'This host holds no attached session by that id.'
)

export function refuseAgentSessionMutation(refusal: AgentSessionWireRefusal): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return { ok: false, refusal }
}

export type AgentSessionMutationSessionPreparation =
  | { ok: true }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type AgentSessionMutationRequest<TValue> = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  logger: StructuredAgentSessionLogger
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  /** Journal of the attached session, read after `prepareSession`; absent when this host holds none. */
  journal: () => AgentSessionJournal | undefined
  /** Between the ledger's answer and the lease check, for a call that may first have to make the
   *  session ready for itself. Answers with the refusal that ends the call, if any. */
  prepareSession?: (
    ledger: Exclude<AgentSessionOperationDecision['decision'], 'refused'>,
    record: AgentSessionRecord
  ) => Promise<AgentSessionMutationSessionPreparation>
  publish: (journal: AgentSessionJournal) => void
  providerChildPhase?: AgentSessionTurnContext['providerChildPhase']
  now: () => number
}

export async function admitAndRunAgentSessionMutation<TValue>(
  request: AgentSessionMutationRequest<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  const { plan, envelope } = request
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const conflict = agentSessionFingerprintConflict(envelope, hostFingerprint)
  if (conflict) {
    return refuseAgentSessionMutation(conflict)
  }
  if (request.prepareSession) {
    const ledger = request.store.evaluateMutationOperation({
      callerKey: request.callerKey,
      envelope,
      hostFingerprint,
      now: request.now(),
      ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
    })
    if (!ledger) {
      return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
    }
    if (ledger.decision.decision !== 'refused') {
      const prepared = await request.prepareSession(ledger.decision.decision, ledger.record)
      if (!prepared.ok) {
        return prepared
      }
    }
  }
  const journal = request.journal()
  if (!journal) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  const operation: AgentSessionMutationOperationAdmission = {
    callerKey: request.callerKey,
    envelope,
    hostFingerprint,
    now: request.now(),
    ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {}),
    ...(plan.conversationWrite ? { conversationWrite: true } : {})
  }
  let admitted: AgentSessionMutationOperationDecision
  let ledgerRowWritten = true
  try {
    admitted = await request.store.admitMutationOperation(operation)
  } catch (error) {
    if (plan.runsWithoutLedgerRow) {
      admitted = admitWithoutLedgerRow(request, operation, error)
      ledgerRowWritten = false
    } else if (
      isAgentSessionRefusalError(error) ||
      classifyJournalOpenFailure(error) === 'journalCorrupt'
    ) {
      // A store refusing the row (a newer Orca's records) or damage SQLite proves: as an open says.
      return refuseAgentSessionMutation(journalOpenRefusal(error))
    } else {
      throw error
    }
  }
  if (!admitted) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  const { admission, record } = admitted
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
      rerunWhenReplayMissing: plan.rerunWhenReplayMissing?.(context),
      recoverUnknownFromDurableState: plan.recoverUnknownFromDurableState
    })
    if (replay.decision === 'refuse') {
      return refuseAgentSessionMutation(replay.refusal)
    }
    if (replay.decision === 'replay') {
      return { ok: true, replayed: true, fence, cursor: journal.cursor(), value: replay.value }
    }
    // Nothing durable landed, so this id is about to run for the first time. A
    // refused call leaves its ledger row behind, and replaying past the lease
    // would let a resend act with no live owner — so a first run pays the full
    // admission price either way.
    const rerun = admitAgentSessionMutation({
      envelope,
      hostFingerprint,
      ledger: { decision: 'admit', row: admission.row },
      lease: record.lease,
      ...(plan.conversationWrite ? { conversationWrite: true } : {})
    })
    if (rerun.decision === 'refused') {
      return refuseAgentSessionMutation(rerun.refusal)
    }
  }

  // With no row, a settle fails on the same storage and turns a landed Stop into a throw.
  const outcome = ledgerRowWritten
    ? await runSettledAgentSessionMutation({
        store: request.store,
        // A global send replay can cross caller identities. Settlement still owns
        // the durable row admitted by the original caller.
        operationCallerKey: admission.row.callerKey,
        envelope,
        plan,
        context
      })
    : await plan.run(context)
  return outcome.ok
    ? { ok: true, replayed: false, fence, cursor: journal.cursor(), value: outcome.value }
    : refuseAgentSessionMutation(outcome.refusal)
}

/** The committed ledger's admission, placing nothing: a failed commit left memory as it was. */
function admitWithoutLedgerRow(
  { store, logger }: Pick<AgentSessionMutationRequest<unknown>, 'store' | 'logger'>,
  operation: AgentSessionMutationOperationAdmission,
  error: unknown
): AgentSessionMutationOperationDecision {
  logger.warn("writing Stop's ledger row failed; Stop runs without it", {
    scope: 'stop-ledger-row',
    sessionId: operation.envelope.sessionId,
    error
  })
  const evaluated = store.evaluateMutationOperation(operation)
  if (!evaluated) {
    return null
  }
  const admission = admitAgentSessionMutation({
    envelope: operation.envelope,
    hostFingerprint: operation.hostFingerprint,
    ledger: evaluated.decision,
    lease: evaluated.record.lease,
    ...(operation.conversationWrite ? { conversationWrite: true } : {})
  })
  return { admission, record: evaluated.record }
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
    logger: request.logger,
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
    ...(request.providerChildPhase ? { providerChildPhase: request.providerChildPhase } : {}),
    now: () => request.now()
  }
}
