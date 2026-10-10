import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  commandReceiptScope,
  type CommandReceipt
} from '../agent-session-journal/command-receipt-schema'
import { buildCommandReceiptTransaction } from '../agent-session-journal/command-receipt-transaction'
import { composeJournalOperationReceipts } from '../agent-session-journal/journal-row-writer'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Acceptance identity and compatibility bookkeeping share the submission or draft's commit. */
export async function runCommandReceiptMutation<TValue>(input: {
  store: AgentSessionRecordStore
  operationCallerKey: string
  fingerprint: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  context: AgentSessionTurnContext
  wakeDelivery?: (sessionId: string) => void
}): Promise<TurnOutcome<TValue> | { committedReceipt: CommandReceipt }> {
  const { store, operationCallerKey, fingerprint, envelope, plan, context, wakeDelivery } = input
  let acceptedReceipt: CommandReceipt | undefined
  let submissionWritten = false
  const receipt = composeJournalOperationReceipts(
    buildCommandReceiptTransaction(
      commandReceiptScope(operationCallerKey, plan.operationIdScope),
      (row) => {
        if (row && row.kind !== 'submission') {
          throw new Error('Send acceptance requires a submission')
        }
        submissionWritten = row !== undefined
        acceptedReceipt = {
          operationId: envelope.clientOperationId,
          sessionId: envelope.sessionId,
          callerKey: operationCallerKey,
          method: plan.method,
          fingerprint,
          status: 'accepted',
          acceptedAt: context.now(),
          result: row
            ? { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
            : { kind: 'queued-draft', messageId: envelope.clientOperationId }
        }
        return acceptedReceipt
      }
    ),
    // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
    store.operationOutcomeReceipt({
      callerKey: operationCallerKey,
      operationId: envelope.clientOperationId,
      fingerprint,
      now: context.now(),
      ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {}),
      outcome: { status: 'succeeded', sessionId: envelope.sessionId }
    })
  )
  let committed = false
  try {
    const ran = await plan.run({
      ...context,
      operationReceipt: {
        write: receipt.write,
        committed: () => {
          committed = true
          receipt.committed()
        }
      }
    })
    if (!committed || ran.ok) {
      return ran
    }
    context.logger.warn('publishing an accepted command failed; replaying its receipt', {
      scope: 'command-receipt-publication',
      sessionId: envelope.sessionId,
      operationId: envelope.clientOperationId,
      refusal: ran.refusal.code
    })
  } catch (error) {
    if (!committed) {
      throw error
    }
    context.logger.warn('publishing an accepted command failed; replaying its receipt', {
      scope: 'command-receipt-publication',
      sessionId: envelope.sessionId,
      operationId: envelope.clientOperationId,
      error
    })
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
  if (!acceptedReceipt) {
    throw new Error('an accepted command requires its committed receipt')
  }
  return { committedReceipt: acceptedReceipt }
}
