import type { AgentSessionReserveRequest } from '../../../runtime/agent-session/ownership/agent-session-reservation-admission'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'
import {
  isAgentSessionRefusalError,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  commandReceiptScope,
  type CommandReceipt,
  type CommandReceiptResult
} from '../../agent-session-journal/writing/command-receipt-schema'
import {
  buildCommandReceiptTransaction,
  CommandReceiptExistsError
} from '../../agent-session-journal/writing/command-receipt-transaction'
import {
  composeJournalOperationReceipts,
  type JournalOperationReceipt
} from '../../agent-session-journal/writing/journal-row-writer'
import type { JournalReceiptRowBinding } from '../../agent-session-journal/journal-writer-effects'
import type {
  MutationCommandReceipt,
  MutationPlan
} from './structured-agent-session-mutation-plans'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type CommandReceiptIdentity = {
  store: AgentSessionRecordStore
  operationCallerKey: string
  fingerprint: string
  envelope: AgentSessionMutationEnvelope
  plan: Pick<MutationPlan<unknown>, 'method' | 'operationIdScope' | 'acceptanceRecord'>
  context: AgentSessionTurnContext
}

export async function runCommandReceiptMutation<TValue>(
  input: CommandReceiptIdentity & {
    plan: MutationPlan<TValue>
    commandReceipt: MutationCommandReceipt<TValue>
    wakeDelivery?: (sessionId: string) => void
  }
): Promise<TurnOutcome<TValue> | { committedReceipt: CommandReceipt }> {
  const { envelope, plan, context, commandReceipt, wakeDelivery } = input
  let acceptedReceipt: CommandReceipt | undefined
  let submissionWritten = false
  let committed = false
  const accepting = (result: CommandReceiptResult, binding?: JournalReceiptRowBinding) => {
    const receipt = acceptanceReceipt(
      input,
      acceptedCommandReceipt(input, result),
      binding,
      (actual, row) => {
        acceptedReceipt = actual
        submissionWritten = row === 'submission'
        committed = true
      }
    )
    return receipt
  }
  const receipt = accepting(
    commandReceipt.binding.absent ?? { kind: 'stop' },
    commandReceipt.binding
  )
  const commitAlone = async (alone: JournalOperationReceipt): Promise<void> => {
    if (!committed) {
      await input.store.commitOperationReceipt(alone)
    }
  }
  try {
    const ran = await plan.run({
      ...context,
      operationReceipt: {
        ...receipt,
        isCommitted: () => committed,
        commitAlone: () => commitAlone(receipt)
      }
    })
    if (!committed) {
      const unwritten = ran.ok ? commandReceipt.unwritten?.(ran.value, context) : null
      return unwritten && !(await commitNoOpReceipt(input, () => commitAlone(accepting(unwritten))))
        ? unknownOutcome(input)
        : ran
    }
    if (ran.ok) {
      return ran
    }
    return failedAfterAcceptance(input, acceptedReceipt, { refusal: ran.refusal.code })
  } catch (error) {
    if (!committed) {
      throw error
    }
    return failedAfterAcceptance(input, acceptedReceipt, { error })
  } finally {
    if (committed && submissionWritten) {
      try {
        wakeDelivery?.(envelope.sessionId)
      } catch (error) {
        context.logger.warn('waking delivery after acceptance failed', {
          scope: 'command-receipt-delivery',
          sessionId: envelope.sessionId,
          error
        })
      }
    }
  }
}

/** Post-commit failures still answer from durable acceptance. */
function failedAfterAcceptance(
  { envelope, context }: CommandReceiptIdentity,
  acceptedReceipt: CommandReceipt | undefined,
  failure: { refusal: string } | { error: unknown }
): { committedReceipt: CommandReceipt } {
  context.logger.warn('publishing an accepted command failed; replaying its receipt', {
    scope: 'command-receipt-publication',
    sessionId: envelope.sessionId,
    operationId: envelope.clientOperationId,
    ...failure
  })
  if (!acceptedReceipt) {
    throw new Error('an accepted command requires its committed receipt')
  }
  return { committedReceipt: acceptedReceipt }
}

function acceptedCommandReceipt(
  { envelope, operationCallerKey, plan, fingerprint, context }: CommandReceiptIdentity,
  result: CommandReceiptResult
): CommandReceipt {
  return {
    operationId: envelope.clientOperationId,
    sessionId: envelope.sessionId,
    callerKey: operationCallerKey,
    method: plan.method,
    fingerprint,
    status: 'accepted',
    acceptedAt: context.now(),
    result
  }
}

function acceptanceReceipt(
  input: CommandReceiptIdentity,
  receipt: CommandReceipt,
  binding: JournalReceiptRowBinding | undefined,
  accepted: NonNullable<Parameters<typeof buildCommandReceiptTransaction>[3]>
): JournalOperationReceipt {
  const { store, operationCallerKey, envelope, plan, fingerprint, context } = input
  return composeJournalOperationReceipts(
    buildCommandReceiptTransaction(
      commandReceiptScope(operationCallerKey, plan.operationIdScope),
      receipt,
      binding,
      accepted
    ),
    // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
    store.operationOutcomeReceipt({
      callerKey: operationCallerKey,
      operationId: envelope.clientOperationId,
      fingerprint,
      ...(plan.acceptanceRecord
        ? { record: { sessionId: envelope.sessionId, action: plan.acceptanceRecord } }
        : {}),
      now: context.now(),
      ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {}),
      outcome: { status: 'succeeded', sessionId: envelope.sessionId }
    })
  )
}

function unknownOutcome(input: CommandReceiptIdentity): TurnOutcome<never> {
  return {
    ok: false,
    refusal: agentSessionOperationOutcomeUnknown(input.envelope.clientOperationId)
  }
}

/** Commit no-op receipts alone; classified refusals propagate, storage faults stay unknown and retryable. */
async function commitNoOpReceipt(
  input: CommandReceiptIdentity,
  commit: () => Promise<void>
): Promise<boolean> {
  try {
    await commit()
    return true
  } catch (error) {
    if (error instanceof CommandReceiptExistsError || isAgentSessionRefusalError(error)) {
      throw error
    }
    input.context.logger.warn(
      'recording a command that changed nothing failed; answering unknown',
      {
        scope: 'command-receipt-unwritten',
        sessionId: input.envelope.sessionId,
        operationId: input.envelope.clientOperationId,
        error
      }
    )
    return false
  }
}

/** Founding and opening-message provenance must commit together. */
export function openingMessageReceipt(
  store: AgentSessionRecordStore,
  request: AgentSessionReserveRequest,
  clientMessageId: string
): JournalOperationReceipt {
  return composeJournalOperationReceipts(
    store.founding.receipt(request),
    buildCommandReceiptTransaction(
      { kind: 'global' },
      {
        operationId: clientMessageId,
        sessionId: request.sessionId,
        callerKey: request.operation.callerKey,
        method: 'agentSession.create',
        fingerprint: request.operation.fingerprint,
        status: 'accepted',
        acceptedAt: request.now,
        result: { kind: 'journal-row', epoch: '', sequence: 0 }
      },
      { at: 'first', kinds: ['submission'], answer: 'journal-row' }
    )
  )
}

export function openingMessageReceiptRefusal(
  error: CommandReceiptExistsError,
  clientMessageId: string,
  envelope: AgentSessionMutationEnvelope
) {
  return error.result.reason === 'conflict'
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'messageIdReused' },
        `Message id ${clientMessageId} was already used for another send.`
      )
    : agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
}
