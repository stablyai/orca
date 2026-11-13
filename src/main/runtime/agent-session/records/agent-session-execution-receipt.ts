import { reconcileOwnedAgentSessionReceipt } from './agent-session-receipt-ownership'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionExecutionPolicyFingerprint } from '../../../../shared/agent-session/agent-session-execution-policy'
import {
  agentSessionExecutionReceiptSchema,
  type AgentSessionExecutionReceiptWrite
} from '../../../../shared/agent-session/agent-session-execution-receipt'

export function applyAgentSessionExecutionReceipt(
  record: AgentSessionRecord,
  input: AgentSessionExecutionReceiptWrite
): AgentSessionRecord {
  const parsed = agentSessionExecutionReceiptSchema.safeParse(input.receipt)
  const previous = agentSessionExecutionReceiptSchema.safeParse(record.executionReceipt)
  const policy = record.executionPolicy
  const evidence = parsed.success ? parsed.data.execution : null
  if (
    !parsed.success ||
    !evidence ||
    record.schemaVersion !== 4 ||
    record.provider !== 'codex' ||
    !policy ||
    evidence.bounded?.policyFingerprint !== agentSessionExecutionPolicyFingerprint(policy) ||
    evidence.account.fingerprint !== policy.accountFingerprint ||
    evidence.model !== policy.model ||
    evidence.effort !== policy.effort
  ) {
    throw new Error('Invalid owned execution receipt.')
  }
  return {
    ...record,
    executionReceipt: {
      ...reconcileOwnedAgentSessionReceipt(
        record,
        input,
        parsed.data,
        previous.success ? previous.data : null
      ),
      ...(previous.success && previous.data.report ? { report: previous.data.report } : {})
    }
  }
}

export function createExecutionReceiptRecorder(
  mutate: (
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>
) {
  return (input: AgentSessionExecutionReceiptWrite) => {
    const snapshot = structuredClone(input)
    return mutate(snapshot.sessionId, (record) =>
      applyAgentSessionExecutionReceipt(record, snapshot)
    )
  }
}
