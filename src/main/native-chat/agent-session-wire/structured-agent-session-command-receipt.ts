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
  const unrecorded = await commitUnrecordedNoOp(input)
  if (unrecorded) {
    // A differing fingerprint is answered as the conflict it is, from the uncommitted receipt.
    return unrecorded === 'unknown' ? unknownOutcome(input) : { committedReceipt: unrecorded }
  }
  let acceptedReceipt: CommandReceipt | undefined
  let submissionWritten = false
  const receipt = acceptanceReceipt(input, (row) => {
    submissionWritten = row?.kind === 'submission'
    acceptedReceipt = acceptedCommandReceipt(input, commandReceipt.result(row))
    return acceptedReceipt
  })
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
    if (!committed) {
      const unwritten = ran.ok ? commandReceipt.unwritten?.(ran.value, context) : null
      return unwritten &&
        !(await commitNoOpReceipt(input, acceptedCommandReceipt(input, unwritten)))
        ? unknownOutcome(input)
        : ran
    }
    if (ran.ok) {
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

/** No-ops answered unknown because their receipt did not commit, per store and receipt key. */
const unrecordedNoOps = new WeakMap<AgentSessionRecordStore, Map<string, CommandReceipt>>()

function unrecordedKey({ operationCallerKey, plan, envelope }: CommandReceiptIdentity): string {
  const scope = commandReceiptScope(operationCallerKey, plan.operationIdScope)
  return `${scope.kind === 'caller' ? scope.callerKey : ''}\u0000${envelope.clientOperationId}`
}

/** A no-op is answered only once its receipt commits, alone. An identity verdict (duplicate,
 *  conflict, unreadable) throws for admission to answer; any other failure is logged, and the
 *  decision is held so a retry in this process commits it rather than deciding again on newer
 *  work. A restart forgets it. */
async function commitNoOpReceipt(
  input: CommandReceiptIdentity,
  receipt: CommandReceipt
): Promise<boolean> {
  try {
    await input.store.commitOperationReceipt(acceptanceReceipt(input, () => receipt))
    return true
  } catch (error) {
    if (
      error instanceof CommandReceiptExistsError ||
      (isAgentSessionRefusalError(error) &&
        error.refusal.code === 'agent_session_operation_conflict')
    ) {
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
    const held = unrecordedNoOps.get(input.store) ?? new Map<string, CommandReceipt>()
    unrecordedNoOps.set(input.store, held.set(unrecordedKey(input), receipt))
    return false
  }
}

/** The no-op this id was answered unknown for, committed now; null when none is held. */
async function commitUnrecordedNoOp(
  input: CommandReceiptIdentity
): Promise<CommandReceipt | 'unknown' | null> {
  const key = unrecordedKey(input)
  const receipt = unrecordedNoOps.get(input.store)?.get(key)
  if (!receipt || receipt.fingerprint !== input.fingerprint) {
    return receipt ?? null
  }
  unrecordedNoOps.get(input.store)?.delete(key)
  return (await commitNoOpReceipt(input, receipt)) ? receipt : 'unknown'
}
