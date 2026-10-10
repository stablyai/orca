import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import { agentSessionLedgerRefusal } from '../../../shared/agent-session-mutation-envelope'
import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { commandReceiptScope } from '../agent-session-journal/command-receipt-schema'
import type { CommandReceipt } from '../agent-session-journal/command-receipt-schema'
import type { ExistingCommandReceipt } from '../agent-session-journal/command-receipt-table'
import { CommandReceiptExistsError } from '../agent-session-journal/command-receipt-transaction'
import {
  AGENT_SESSION_NOT_ATTACHED,
  refuseAgentSessionMutation
} from './structured-agent-session-mutation-refusals'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import { mutationTurnContext } from './structured-agent-session-mutation-turn-context'
import { runCommandReceiptMutation } from './structured-agent-session-command-receipt'
import {
  agentSessionOperationOutcomeUnknown,
  resolveAgentSessionReplayOutcome
} from './structured-agent-session-replay-outcome'

/** Submission-accepting plans use their effect's receipt, never a ledger reservation. */
export async function admitCommandReceiptMutation<TValue>(
  request: AgentSessionMutationRequest<TValue>,
  hostFingerprint: string
): Promise<AgentSessionMutationResult<TValue>> {
  const { store, envelope, plan, callerKey } = request
  if (parseAgentSessionOperationTimestamp(envelope.clientOperationId) === null) {
    return refuseAgentSessionMutation(
      agentSessionLedgerRefusal(envelope, {
        decision: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'operationIdInvalid' }
      })
    )
  }
  const record = store.getRecord(envelope.sessionId)
  if (!record) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  let read
  try {
    read = store.readCommandReceipt(
      commandReceiptScope(callerKey, plan.operationIdScope),
      envelope.clientOperationId
    )
  } catch (error) {
    request.logger.warn('reading a command receipt failed', {
      scope: 'command-receipt-read',
      sessionId: envelope.sessionId,
      operationId: envelope.clientOperationId,
      error
    })
    return unknown(request)
  }
  if (read.verdict !== 'absent') {
    return answerCommandReceipt(request, hostFingerprint, read)
  }
  const prepared = await request.prepareSession?.('admit', record)
  if (prepared && !prepared.ok) {
    return prepared
  }
  const journal = request.journal()
  const current = store.getRecord(envelope.sessionId)
  if (!journal || !current) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  // These plans write only to the conversation, whose journal enforces the execution-host fence.
  const context = mutationTurnContext(request, journal, current)
  try {
    const outcome = await runCommandReceiptMutation({
      store,
      operationCallerKey: callerKey,
      fingerprint: hostFingerprint,
      wakeDelivery: request.wakeDelivery,
      envelope,
      plan,
      context
    })
    if ('committedReceipt' in outcome) {
      return answerCommandReceipt(request, hostFingerprint, {
        verdict: 'readable',
        receipt: outcome.committedReceipt
      })
    }
    return outcome.ok
      ? {
          ok: true,
          replayed: false,
          fence: context.fence,
          cursor: journal.cursor(),
          value: outcome.value
        }
      : refuseAgentSessionMutation(outcome.refusal)
  } catch (error) {
    if (error instanceof CommandReceiptExistsError) {
      return answerCommandReceipt(request, hostFingerprint, error.result.existing)
    }
    if (isAgentSessionRefusalError(error)) {
      return refuseAgentSessionMutation(error.refusal)
    }
    throw error
  }
}

async function answerCommandReceipt<TValue>(
  request: AgentSessionMutationRequest<TValue>,
  hostFingerprint: string,
  read: ExistingCommandReceipt
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, plan } = request
  if (read.verdict === 'unreadable') {
    return unknown(request)
  }
  const { receipt } = read
  if (receipt.fingerprint !== hostFingerprint) {
    return refuseAgentSessionMutation(
      agentSessionLedgerRefusal(envelope, {
        decision: 'refused',
        code: 'agent_session_operation_conflict',
        details: { reason: 'operationIdReused' }
      })
    )
  }
  if (receipt.status === 'rejected') {
    return refuseAgentSessionMutation(
      agentSessionRefusalFromReference(
        receipt.rejection.reference,
        receipt.rejection.message ?? 'Operation was already refused.'
      )
    )
  }
  const record = request.store.getRecord(envelope.sessionId)
  if (!record) {
    return unknown(request)
  }
  const prepared = await request.prepareSession?.('replay', record)
  if (prepared && !prepared.ok) {
    return prepared
  }
  const journal = request.journal()
  const current = request.store.getRecord(envelope.sessionId)
  if (!journal || !current) {
    return unknown(request)
  }
  const context = mutationTurnContext(request, journal, current)
  const outcome = commandReceiptOutcome(receipt)
  const replay = resolveAgentSessionReplayOutcome({
    operationId: envelope.clientOperationId,
    outcome,
    reconstruct: () => plan.replay(context, outcome),
    rerunWhenReplayMissing: plan.rerunWhenReplayMissing?.(context),
    recoverUnknownFromDurableState: plan.recoverUnknownFromDurableState
  })
  // A missing result cannot undo durable acceptance, even if a later plan allows missing replays.
  if (replay.decision !== 'replay') {
    return replay.decision === 'refuse'
      ? refuseAgentSessionMutation(replay.refusal)
      : unknown(request)
  }
  return {
    ok: true,
    replayed: true,
    fence: context.fence,
    cursor: journal.cursor(),
    value: replay.value
  }
}

function commandReceiptOutcome(receipt: CommandReceipt): AgentSessionOperationOutcome {
  return { status: 'succeeded', sessionId: receipt.sessionId }
}

function unknown<TValue>(request: AgentSessionMutationRequest<TValue>) {
  return refuseAgentSessionMutation(
    agentSessionOperationOutcomeUnknown(request.envelope.clientOperationId)
  )
}
