import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../../shared/agent-session/agent-session-advisory-policy'
import {
  agentSessionAdvisoryReceiptSchema,
  type AgentSessionAdvisoryReceiptWrite
} from '../../../../shared/agent-session/agent-session-advisory-receipt'
import { reconcileOwnedAgentSessionReceipt } from './agent-session-receipt-ownership'

export function applyAgentSessionAdvisoryReceipt(
  record: AgentSessionRecord,
  input: AgentSessionAdvisoryReceiptWrite
): AgentSessionRecord {
  const parsed = agentSessionAdvisoryReceiptSchema.safeParse(input.receipt)
  const previous = agentSessionAdvisoryReceiptSchema.safeParse(record.advisoryReceipt)
  const policy = record.advisoryPolicy
  if (
    !parsed.success ||
    record.schemaVersion !== 3 ||
    record.provider !== 'claude' ||
    record.executionPolicy ||
    policy?.schema !== 2
  ) {
    throw new Error('Invalid owned advisory receipt.')
  }
  const facts = parsed.data.execution
  const binding = facts.binding
  if (
    facts.bounded.policyFingerprint !== agentSessionAdvisoryPolicyFingerprint(policy) ||
    facts.bounded.deadlineAt !== policy.deadlineAt ||
    facts.bounded.maxModelCalls !== policy.maxModelCalls ||
    (!parsed.data.invalidated &&
      (facts.bounded.modelCalls > policy.maxModelCalls ||
        (facts.bounded.inputAdmitted &&
          (!facts.bounded.hooksApplied ||
            !binding ||
            binding.accountFingerprint !== policy.binding.accountFingerprint ||
            binding.model !== policy.binding.model ||
            binding.effort !== policy.binding.effort)) ||
        (parsed.data.turnCompleted && !facts.bounded.inputAdmitted))) ||
    (parsed.data.closure && parsed.data.closure.observedAt < facts.observedAt)
  ) {
    throw new Error('Invalid owned advisory receipt.')
  }
  return {
    ...record,
    advisoryReceipt: reconcileOwnedAgentSessionReceipt(
      record,
      input,
      parsed.data,
      previous.success ? previous.data : null
    )
  }
}

export function createAdvisoryReceiptRecorder(
  mutate: (
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>
) {
  return (input: AgentSessionAdvisoryReceiptWrite) => {
    const snapshot = structuredClone(input)
    return mutate(snapshot.sessionId, (record) =>
      applyAgentSessionAdvisoryReceipt(record, snapshot)
    )
  }
}
