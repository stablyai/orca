import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  commandReceiptScope,
  type CommandReceipt,
  type CommandReceiptResult
} from '../agent-session-journal/command-receipt-schema'
import {
  buildCommandReceiptTransaction,
  CommandReceiptExistsError
} from '../agent-session-journal/command-receipt-transaction'
import {
  composeJournalOperationReceipts,
  type JournalOperationReceipt
} from '../agent-session-journal/journal-row-writer'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
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
  plan: { method: string; operationIdScope?: 'global' }
  context: AgentSessionTurnContext
}

/** Acceptance identity and compatibility bookkeeping share the commit of the command's effect. */
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
  const accepting = (result: (row?: JournalRow) => CommandReceiptResult) => {
    const receipt = acceptanceReceipt(input, (row) => {
      acceptedReceipt = acceptedCommandReceipt(input, result(row))
      return acceptedReceipt
    })
    return {
      write: receipt.write,
      committed: () => {
        committed = true
        receipt.committed()
      }
    }
  }
  const receipt = accepting((row) => {
    submissionWritten = row?.kind === 'submission'
    return commandReceipt.result(row)
  })
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
      return unwritten &&
        !(await commitNoOpReceipt(input, () => commitAlone(accepting(() => unwritten))))
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

/** Accepted, then failed: the answer is its receipt, whatever went wrong after the commit. */
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
  receipt: (row?: JournalRow) => CommandReceipt
): JournalOperationReceipt {
  const { store, operationCallerKey, envelope, plan, fingerprint, context } = input
  return composeJournalOperationReceipts(
    buildCommandReceiptTransaction(
      commandReceiptScope(operationCallerKey, plan.operationIdScope),
      receipt
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
}

function unknownOutcome(input: CommandReceiptIdentity): TurnOutcome<never> {
  return {
    ok: false,
    refusal: agentSessionOperationOutcomeUnknown(input.envelope.clientOperationId)
  }
}

/** A no-op is answered only once its receipt commits, alone. An identity verdict or a classified
 *  refusal throws for admission to answer; an unclassified storage failure is logged and answered
 *  unknown, with nothing recorded, so a retry decides afresh. */
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
