// Ledger admission for mutations that are not reservations — send, cancel, an
// approval answer. Split from the store so the store keeps only the transaction.

import {
  evaluateAgentSessionOperation,
  type AgentSessionOperationClaim,
  type AgentSessionOperationDecision,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationOwnedPane
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionMutation,
  type AgentSessionMutationAdmission
} from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

export type AgentSessionOperationAdmission = {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}

export type AgentSessionMutationOperationAdmission = {
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  hostFingerprint: string
  now: number
  operationIdScope?: 'global'
  conversationWrite?: true
}

export type AgentSessionMutationOperationDecision = {
  admission: AgentSessionMutationAdmission
  record: AgentSessionRecord
} | null

/** The ledger's answer for a mutation, placing nothing and checking no lease: what a call must
 *  know before it decides whether to give the session an owner. Null when no record exists. */
export function evaluateAgentSessionMutationOperation(
  state: Pick<AgentSessionStoreState, 'records' | 'operations'>,
  args: AgentSessionMutationOperationAdmission
): { decision: AgentSessionOperationDecision; record: AgentSessionRecord } | null {
  const record = state.records.get(args.envelope.sessionId)
  if (!record) {
    return null
  }
  const operation = mutationOperation(args)
  return { decision: state.operations.evaluate(operation, Boolean(args.operationIdScope)), record }
}

/** The same answer as if no row were recorded: for a call that must run when the ledger can't be
 *  read. Null when no record exists. */
export function evaluateAgentSessionMutationWithoutLedger(
  record: AgentSessionRecord | null,
  args: AgentSessionMutationOperationAdmission
): { decision: AgentSessionOperationDecision; record: AgentSessionRecord } | null {
  return record
    ? {
        decision: evaluateAgentSessionOperation({ rows: new Map(), ...mutationOperation(args) }),
        record
      }
    : null
}

function mutationOperation(
  args: AgentSessionMutationOperationAdmission
): AgentSessionOperationAdmission {
  return {
    callerKey: args.callerKey,
    operationId: args.envelope.clientOperationId,
    fingerprint: args.hostFingerprint,
    now: args.now
  }
}

/** Admit the ledger row and its writer-lease precondition in one durable transaction. */
export function admitAgentSessionMutationOperation(
  state: AgentSessionStoreState,
  args: AgentSessionMutationOperationAdmission
): AgentSessionMutationOperationDecision {
  const record = state.records.get(args.envelope.sessionId)
  if (!record) {
    return null
  }
  const operation = mutationOperation(args)
  const ledger = state.operations.evaluate(operation, Boolean(args.operationIdScope))
  const admission = admitAgentSessionMutation({
    envelope: args.envelope,
    hostFingerprint: args.hostFingerprint,
    ledger,
    lease: record.lease,
    ...(args.conversationWrite ? { conversationWrite: true } : {})
  })
  if (ledger.decision === 'admit' && admission.decision !== 'refused') {
    state.operations.put(ledger.row)
  }
  return { admission, record }
}

export function admitAgentSessionOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: AgentSessionOperationAdmission
): AgentSessionOperationDecision {
  const decision = state.operations.evaluate(args)
  if (decision.decision === 'admit') {
    state.operations.put(decision.row)
  }
  return decision
}

export function admitAgentSessionGlobalOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: AgentSessionOperationAdmission
): AgentSessionOperationDecision {
  const decision = state.operations.evaluate(args, true)
  if (decision.decision === 'admit') {
    state.operations.put(decision.row)
  }
  return decision
}

export function claimAgentSessionOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: {
    callerKey: string
    operationId: string
    ownedPane?: AgentSessionOperationOwnedPane
    terminalCreate?: unknown
  }
): AgentSessionOperationClaim {
  return state.operations.claim(args)
}

/** Whether an admission left the right to run open, so the same transaction should claim it. */
export type ClaimAfterAdmission = (decision: AgentSessionOperationDecision) => boolean

/** An admission whose claimant laid out a pane before its effect; recorded only if the claim wins. */
export type AgentSessionOperationClaimingAdmission = AgentSessionOperationAdmission & {
  ownedPane?: AgentSessionOperationOwnedPane
  terminalCreate?: unknown
}

/** Admission and its conditional claim commit together before the effect. */
export function admitAndClaimAgentSessionOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: AgentSessionOperationClaimingAdmission,
  claimAfter: ClaimAfterAdmission
): { decision: AgentSessionOperationDecision; claim: AgentSessionOperationClaim | null } {
  const decision = admitAgentSessionOperationInto(state, args)
  return {
    decision,
    claim: claimAfter(decision) ? claimAgentSessionOperationInto(state, args) : null
  }
}

export function settleAgentSessionOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: { callerKey?: string; operationId: string; outcome: AgentSessionOperationOutcome }
): void {
  state.operations.settle(args)
}
