import { createHash } from 'node:crypto'
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
  const tokenHash = createHash('sha256').update(input.spawnToken).digest('hex')
  const policy = record.executionPolicy
  const evidence = parsed.success ? parsed.data.execution : null
  if (
    !parsed.success ||
    !evidence ||
    record.schemaVersion !== 4 ||
    record.provider !== 'codex' ||
    !policy ||
    input.sessionId !== record.sessionId ||
    evidence.sessionId !== record.sessionId ||
    input.fence !== record.lease.runtimeFence ||
    evidence.runtimeFence !== input.fence ||
    evidence.acquisitionGeneration !== input.generation ||
    parsed.data.spawnTokenHash !== tokenHash ||
    evidence.bounded?.policyFingerprint !== agentSessionExecutionPolicyFingerprint(policy) ||
    evidence.account.fingerprint !== policy.accountFingerprint ||
    evidence.model !== policy.model ||
    evidence.effort !== policy.effort ||
    (previous.success &&
      (previous.data.execution.acquisitionGeneration !== input.generation ||
        previous.data.spawnTokenHash !== tokenHash)) ||
    !(
      (record.lease.claimStatus === 'live' &&
        record.lease.ownerProcess?.spawnToken === input.spawnToken) ||
      (previous.success && previous.data.spawnTokenHash === tokenHash)
    )
  ) {
    throw new Error('Invalid owned execution receipt.')
  }
  return {
    ...record,
    executionReceipt: {
      ...parsed.data,
      invalidated: parsed.data.invalidated || (previous.success && previous.data.invalidated),
      turnCompleted: parsed.data.turnCompleted || (previous.success && previous.data.turnCompleted),
      ...(previous.success &&
      previous.data.closure?.root === 'exited' &&
      previous.data.closure.tree === 'exited'
        ? { closure: previous.data.closure }
        : parsed.data.closure
          ? {}
          : previous.success && previous.data.closure
            ? { closure: previous.data.closure }
            : {}),
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
