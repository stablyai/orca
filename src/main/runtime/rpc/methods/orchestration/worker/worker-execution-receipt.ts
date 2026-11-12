import { executionBuildHash as buildHash } from '../../../../agent-session/records/agent-session-execution-runtime'
import { agentSessionExecutionReceiptSchema } from '../../../../../../shared/agent-session/agent-session-execution-receipt'
import { agentSessionExecutionPolicyFingerprint } from '../../../../../../shared/agent-session/agent-session-execution-policy'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationWorkerSettings } from '../../../../../../shared/orchestration/workers/orchestration-worker-settings'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { workerStartOptionsExecutionPolicyFingerprint } from '../../../../orchestration/workers/launch/worker-launch-observation'

export async function readWorkerExecutionReceipt(
  host: StructuredAgentSessionHost,
  db: OrchestrationDb,
  dispatchId: string,
  runtimeId: string | undefined
): Promise<OrchestrationWorkerSettings | null> {
  const dispatch = db.getDispatchContextById(dispatchId)
  const sessionId = dispatch?.assignee_orca_session_id
  const record = sessionId && host.deps.store.getRecord(sessionId)
  if (!record?.executionPolicy) {
    return null
  }
  const parsed = agentSessionExecutionReceiptSchema.safeParse(record.executionReceipt)
  if (!parsed.success || !parsed.data.closure) {
    return null
  }
  const unknown = { kind: 'unknown' as const, reason: 'identity_changed' as const }
  const receipt = parsed.data
  const fingerprint = agentSessionExecutionPolicyFingerprint(record.executionPolicy)
  const task = dispatch && db.getTask(dispatch.task_id)
  if (
    !runtimeId ||
    !receipt.runtime ||
    buildHash === 'unknown' ||
    !dispatch ||
    !task ||
    task.run_id !== dispatch.run_id ||
    record.provider !== 'codex' ||
    record.schemaVersion !== 4 ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    record.location.workspaceKind !== 'folder' ||
    receipt.execution.sessionId !== sessionId ||
    receipt.execution.runtimeFence !== record.lease.runtimeFence ||
    receipt.execution.bounded?.policyFingerprint !== fingerprint ||
    workerStartOptionsExecutionPolicyFingerprint(
      db.getWorkerDispatch(dispatchId)?.start_options ?? ''
    ) !== fingerprint
  ) {
    return unknown
  }
  const metadata = await host.deps.adapter?.readExecutionQualification?.(record).catch(() => null)
  const after = host.deps.store.getRecord(record.sessionId)
  if (
    after?.executionReceipt !== record.executionReceipt ||
    db.getDispatchContextById(dispatchId)?.assignee_orca_session_id !== sessionId ||
    workerStartOptionsExecutionPolicyFingerprint(
      db.getWorkerDispatch(dispatchId)?.start_options ?? ''
    ) !== fingerprint
  ) {
    return unknown
  }
  const { spawnTokenHash: _private, ...publicReceipt } = receipt
  return {
    kind: 'execution-receipt',
    sessionId: record.sessionId,
    runtimeFence: record.lease.runtimeFence,
    agent: 'codex',
    qualification: {
      runtime: structuredClone(receipt.runtime),
      policy: structuredClone(record.executionPolicy),
      receipt: structuredClone(publicReceipt),
      metadata: metadata ?? null
    }
  }
}
