import { isDeepStrictEqual } from 'node:util'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../../../shared/agent-session/agent-session-advisory-policy'
import {
  agentSessionAdvisoryReportSchema,
  type AgentSessionAdvisoryReporterFactory
} from '../../../../../shared/agent-session/agent-session-advisory-report'
import { acquiredAgentSessionAccount } from '../../../../../shared/agent-session/lifecycle/agent-session-acquired-account'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { workerReportRefusal } from './worker-report-admission'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import { sendPointToPointMessage } from '../../../rpc/methods/orchestration/messaging/send-point-to-point'
import { workerStartOptionsAdvisoryPolicyFingerprint } from '../launch/worker-launch-observation'

export function createAdvisoryReportPublisher(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'notifyMessageArrived'>
): AgentSessionAdvisoryReporterFactory {
  return (binding) => prepareAdvisoryReport(runtime, binding)
}

function prepareAdvisoryReport(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'notifyMessageArrived'>,
  binding: Parameters<AgentSessionAdvisoryReporterFactory>[0]
) {
  const db = runtime.getOrchestrationDb()
  const host = getStructuredAgentSessionHost()
  const initial = host?.deps.store.getRecord(binding.sessionId)
  const identity = resolveStructuredWorkerIdentityForSession(binding.sessionId, db)
  const dispatch = identity && db.findActiveDispatchForAssignee(identity.handle, identity.paneKey)
  const refused = (): never => {
    throw new Error('Advisory report authority unavailable.')
  }
  if (
    !host ||
    !initial?.advisoryPolicy ||
    initial.schemaVersion !== 3 ||
    !identity ||
    !dispatch ||
    identity.sessionId !== binding.sessionId ||
    identity.worktreeId !== initial.location.workspaceId ||
    identity.hostScope.kind !== 'local' ||
    identity.hostScope.hostId !== 'local' ||
    initial.location.executionHostId !== 'local' ||
    initial.location.wslDistro !== null ||
    initial.location.workspaceKind !== 'folder' ||
    initial.provider !== 'claude' ||
    initial.lease.runtimeFence !== binding.fence ||
    (initial.lease.reservedSpawnToken ?? initial.lease.ownerProcess?.spawnToken) !==
      binding.spawnToken ||
    dispatch.assignee_orca_session_id !== binding.sessionId
  ) {
    return refused()
  }
  const policy = structuredClone(initial.advisoryPolicy)
  const fingerprint = agentSessionAdvisoryPolicyFingerprint(policy)
  const task = db.getTask(dispatch.task_id)
  const readFingerprint = () =>
    workerStartOptionsAdvisoryPolicyFingerprint(
      db.getWorkerDispatch(dispatch.id)?.start_options ?? ''
    )
  if (
    !task?.parent_id ||
    db.getTask(task.parent_id)?.run_id !== dispatch.run_id ||
    readFingerprint() !== fingerprint
  ) {
    return refused()
  }
  return async (input) => {
    const record = host.deps.store.getRecord(binding.sessionId)
    const generation = binding.currentGeneration()
    const acquired = record && acquiredAgentSessionAccount(record, 'local')
    const current = db.findActiveDispatchForAssignee(identity.handle, identity.paneKey)
    const now = host.deps.now?.() ?? Date.now()
    if (
      getStructuredAgentSessionHost() !== host ||
      runtime.getOrchestrationDb() !== db ||
      !record ||
      record.lease.claimStatus !== 'live' ||
      record.lease.runtimeFence !== binding.fence ||
      record.lease.ownerProcess?.spawnToken !== binding.spawnToken ||
      !generation ||
      acquired?.generation !== generation ||
      acquired.spawnToken !== binding.spawnToken ||
      !isDeepStrictEqual(record.advisoryPolicy, policy) ||
      now >= policy.deadlineAt ||
      db.getTask(dispatch.task_id)?.parent_id !== task.parent_id ||
      readFingerprint() !== fingerprint ||
      current?.id !== dispatch.id ||
      current.task_id !== dispatch.task_id ||
      workerReportRefusal({
        dispatchId: dispatch.id,
        from: identity.handle,
        workerState: db.getWorkerDispatch(dispatch.id)?.state,
        processCurrent: db.isDispatchProcessCurrent({
          dispatchId: dispatch.id,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation
        })
      })
    ) {
      return refused()
    }
    const parsed = agentSessionAdvisoryReportSchema.safeParse(input)
    if (!parsed.success) {
      return refused()
    }
    const report = parsed.data
    const receipt = sendPointToPointMessage({
      runtime,
      db,
      params: {
        from: identity.handle,
        subject: `Advisor: ${report.status}`,
        type: 'worker_done',
        body: JSON.stringify({ source_pin: policy.sourcePin, advisor: dispatch.id, ...report }),
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          outcome: report.status === 'error' || report.status === 'timeout' ? 'failed' : 'succeeded'
        })
      },
      from: identity.handle,
      to: dispatchReportMailbox(db, current),
      dispatchId: dispatch.id,
      messageRunId: dispatch.run_id,
      senderPaneKey: identity.paneKey,
      resolveProcessIncarnation: () => identity.processIncarnation,
      legacyCoordinatorRunId: undefined,
      revalidateLegacyCoordinator: undefined,
      recordMutationReceipt: undefined,
      markWorkerDoneMutationEffectFree: undefined,
      withSendWarnings: (value) => value
    })
    if (
      typeof receipt !== 'object' ||
      receipt === null ||
      !('lifecycle' in receipt) ||
      typeof receipt.lifecycle !== 'object' ||
      receipt.lifecycle === null ||
      !('action' in receipt.lifecycle) ||
      (receipt.lifecycle.action !== 'completed' && receipt.lifecycle.action !== 'failed')
    ) {
      refused()
    }
  }
}
