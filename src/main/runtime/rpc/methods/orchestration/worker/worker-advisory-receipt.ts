import { executionBuildHash } from '../../../../agent-session/records/agent-session-execution-runtime'
import { agentSessionAdvisoryReceiptSchema } from '../../../../../../shared/agent-session/agent-session-advisory-receipt'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../../../../shared/agent-session/agent-session-advisory-policy'
import { workerStartOptionsAdvisoryPolicyFingerprint } from '../../../../orchestration/workers/launch/worker-launch-observation'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationWorkerSettings } from '../../../../../../shared/orchestration/workers/orchestration-worker-settings'

export function readWorkerAdvisoryReceipt(
  host: StructuredAgentSessionHost,
  db: OrchestrationDb,
  dispatchId: string,
  runtimeId: string | undefined
): OrchestrationWorkerSettings | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  const record =
    dispatch?.assignee_orca_session_id &&
    host.deps.store.getRecord(dispatch.assignee_orca_session_id)
  if (!record || record.advisoryPolicy?.schema !== 2) {
    return null
  }
  const parsed = agentSessionAdvisoryReceiptSchema.safeParse(record.advisoryReceipt)
  if (!parsed.success || !parsed.data.closure) {
    return null
  }
  const receipt = parsed.data
  const unknown = { kind: 'unknown' as const, reason: 'identity_changed' as const }
  const released =
    record.lease.claimStatus === 'released' &&
    !record.lease.ownerProcess &&
    !record.lease.reservedSpawnToken &&
    record.lease.runtimeFence === receipt.execution.runtimeFence + 1
  const fingerprint = agentSessionAdvisoryPolicyFingerprint(record.advisoryPolicy)
  if (
    !dispatch ||
    !runtimeId ||
    !receipt.runtime ||
    executionBuildHash === 'unknown' ||
    record.provider !== 'claude' ||
    record.schemaVersion !== 3 ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    record.location.workspaceKind !== 'folder' ||
    db.getTask(dispatch.task_id)?.run_id !== dispatch.run_id ||
    receipt.execution.sessionId !== record.sessionId ||
    (receipt.execution.runtimeFence !== record.lease.runtimeFence && !released) ||
    receipt.execution.bounded.policyFingerprint !== fingerprint ||
    workerStartOptionsAdvisoryPolicyFingerprint(
      db.getWorkerDispatch(dispatchId)?.start_options ?? ''
    ) !== fingerprint
  ) {
    return unknown
  }
  const { spawnTokenHash: _private, ...publicReceipt } = receipt
  const { schema, sourcePin, dataScope, deadlineAt, maxModelCalls, binding } = record.advisoryPolicy
  return {
    kind: 'advisory-receipt',
    sessionId: record.sessionId,
    runtimeFence: receipt.execution.runtimeFence,
    agent: 'claude',
    qualification: {
      runtime: structuredClone(receipt.runtime),
      policy: structuredClone({ schema, sourcePin, dataScope, deadlineAt, maxModelCalls, binding }),
      receipt: structuredClone(publicReceipt),
      metadata: null
    }
  }
}
