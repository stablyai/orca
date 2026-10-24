// Validate fingerprints centrally. Prepare ledger replays without admitting writes; first runs
// prepare ownership before lease admission, while command-receipt plans use their own admission.

import {
  admitAgentSessionMutation,
  agentSessionFingerprintConflict,
  agentSessionLedgerRefusal,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionOperationDecision,
  AgentSessionOperationRow
} from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
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
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { runSettledAgentSessionMutation } from './structured-agent-session-operation-settlement'
import {
  agentSessionOperationOutcomeUnknown,
  resolveAgentSessionReplayOutcome
} from './structured-agent-session-replay-outcome'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { mutationTurnContext } from './structured-agent-session-mutation-turn-context'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import { admitCommandReceiptMutation } from './structured-agent-session-command-admission'

import {
  AGENT_SESSION_NOT_ATTACHED,
  refuseAgentSessionMutation
} from './structured-agent-session-mutation-refusals'
export {
  AGENT_SESSION_NOT_ATTACHED,
  refuseAgentSessionMutation
} from './structured-agent-session-mutation-refusals'

export type AgentSessionMutationSessionPreparation =
  | { ok: true }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type AgentSessionMutationRequest<TValue> = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  logger: StructuredAgentSessionLogger
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  /** Read after preparation; absent if no conversation is held. */
  journal: () => AgentSessionJournal | undefined
  currentWork?: () => StructuredAgentSessionCurrentWork | null
  /** Prepare between ledger evaluation and lease admission; return any terminal refusal. */
  prepareSession?: (
    ledger: Exclude<AgentSessionOperationDecision['decision'], 'refused'>,
    record: AgentSessionRecord
  ) => Promise<AgentSessionMutationSessionPreparation>
  publish: (journal: AgentSessionJournal) => void
  wakeDelivery?: (sessionId: string) => void
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
  if (plan.commandReceipt) {
    return admitCommandReceiptMutation(request, hostFingerprint, plan.commandReceipt)
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
    if (ledger.decision.decision === 'refused') {
      return refuseAgentSessionMutation(agentSessionLedgerRefusal(envelope, ledger.decision))
    }
    if (ledger.decision.decision === 'replay') {
      const answered = await answerRecordedOperation(
        request,
        request.prepareSession,
        ledger.decision.row,
        ledger.record,
        hostFingerprint
      )
      if (answered !== 'rerun') {
        return answered
      }
    }
    const record = request.store.getRecord(envelope.sessionId) ?? ledger.record
    const prepared = await request.prepareSession('admit', record)
    if (!prepared.ok) {
      return prepared
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
  try {
    admitted = await request.store.admitMutationOperation(operation)
  } catch (error) {
    if (
      isAgentSessionRefusalError(error) ||
      classifyJournalOpenFailure(error) === 'journalCorrupt'
    ) {
      // Match open-time refusal for newer records or proven SQLite corruption.
      return refuseAgentSessionMutation(journalOpenRefusal(error))
    }
    throw error
  }
  if (!admitted) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  const { admission, record } = admitted
  if (admission.decision === 'refused') {
    return refuseAgentSessionMutation(admission.refusal)
  }

  const fence = record.lease.runtimeFence
  const context = mutationTurnContext(request, journal, record)
  if (admission.decision === 'replay') {
    const replayed = replayRecordedOperation(request, context, admission.row)
    if (replayed !== 'rerun') {
      return replayed
    }
    // No durable effect landed; require first-run lease admission even if a refused ledger row exists.
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

  const outcome = await runSettledAgentSessionMutation({
    store: request.store,
    // Global replay may cross callers; settle the original caller’s durable row.
    operationCallerKey: admission.row.callerKey,
    envelope,
    plan,
    context
  })
  return outcome.ok
    ? { ok: true, replayed: false, fence, cursor: journal.cursor(), value: outcome.value }
    : refuseAgentSessionMutation(outcome.refusal)
}

/** Replay recorded failures directly; otherwise prepare/read without admission, rerunning only absent effects. */
async function answerRecordedOperation<TValue>(
  request: AgentSessionMutationRequest<TValue>,
  prepareSession: NonNullable<AgentSessionMutationRequest<TValue>['prepareSession']>,
  row: AgentSessionOperationRow,
  record: AgentSessionRecord,
  hostFingerprint: string
): Promise<AgentSessionMutationResult<TValue> | 'rerun'> {
  const { plan, envelope } = request
  if (row.outcome.status === 'failed') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: envelope.clientOperationId,
      outcome: row.outcome,
      reconstruct: () => null
    })
    if (replay.decision === 'refuse') {
      return refuseAgentSessionMutation(replay.refusal)
    }
  }
  const prepared = await prepareSession('replay', record)
  if (!prepared.ok) {
    return prepared
  }
  const journal = request.journal()
  // Opening may change the record or receipt; evaluate again.
  const current = request.store.evaluateMutationOperation({
    callerKey: request.callerKey,
    envelope,
    hostFingerprint,
    now: request.now(),
    ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
  })
  if (!journal || !current) {
    return refuseAgentSessionMutation(
      agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
    )
  }
  if (current.decision.decision === 'refused') {
    return refuseAgentSessionMutation(agentSessionLedgerRefusal(envelope, current.decision))
  }
  if (current.decision.decision === 'admit') {
    return 'rerun'
  }
  const context = mutationTurnContext(request, journal, current.record)
  return replayRecordedOperation(request, context, current.decision.row)
}

/** Reconstruct the recorded answer; rerun only when no durable effect landed. */
export function replayRecordedOperation<TValue>(
  {
    plan,
    envelope
  }: {
    plan: Pick<
      MutationPlan<TValue>,
      'replay' | 'rerunWhenReplayMissing' | 'recoverUnknownFromDurableState'
    >
    envelope: AgentSessionMutationEnvelope
  },
  context: AgentSessionTurnContext,
  row: AgentSessionOperationRow
): AgentSessionMutationResult<TValue> | 'rerun' {
  const replay = resolveAgentSessionReplayOutcome({
    operationId: envelope.clientOperationId,
    outcome: row.outcome,
    reconstruct: () => plan.replay(context, row.outcome),
    rerunWhenReplayMissing: plan.rerunWhenReplayMissing?.(context),
    recoverUnknownFromDurableState: plan.recoverUnknownFromDurableState
  })
  if (replay.decision === 'refuse') {
    return refuseAgentSessionMutation(replay.refusal)
  }
  return replay.decision === 'replay'
    ? {
        ok: true,
        replayed: true,
        fence: context.fence,
        cursor: context.journal.cursor(),
        value: replay.value
      }
    : 'rerun'
}
