import { executionBuildHash } from '../../../agent-session/records/agent-session-execution-runtime'
import { createAdvisoryReportPublisher } from './agent-session-advisory-report'
import { agentSessionExecutionPolicyFingerprint } from '../../../../../shared/agent-session/agent-session-execution-policy'
import { agentSessionExecutionReceiptSchema } from '../../../../../shared/agent-session/agent-session-execution-receipt'
import {
  agentSessionExecutionReportSchema,
  type AgentSessionExecutionReporterFactory
} from '../../../../../shared/agent-session/agent-session-execution-report'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { workerStartOptionsExecutionPolicyFingerprint } from '../launch/worker-launch-observation'
import { workerReportRefusal } from './worker-report-admission'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import { sendPointToPointMessage } from '../../../rpc/methods/orchestration/messaging/send-point-to-point'

export function createExecutionReportPublisher(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'notifyMessageArrived'>
): AgentSessionExecutionReporterFactory {
  return (binding) => {
    const db = runtime.getOrchestrationDb()
    const host = getStructuredAgentSessionHost()
    const initial = host?.deps.store.getRecord(binding.sessionId)
    const identity = resolveStructuredWorkerIdentityForSession(binding.sessionId, db)
    const dispatch = identity && db.findActiveDispatchForAssignee(identity.handle, identity.paneKey)
    const refused = (): never => {
      throw new Error('Bounded worker report authority unavailable.')
    }
    if (
      !host ||
      !initial?.executionPolicy ||
      initial.schemaVersion !== 4 ||
      !identity ||
      !dispatch ||
      initial.provider !== 'codex' ||
      identity.sessionId !== binding.sessionId ||
      identity.worktreeId !== initial.location.workspaceId ||
      identity.hostScope.kind !== 'local' ||
      identity.hostScope.hostId !== 'local' ||
      initial.location.executionHostId !== 'local' ||
      initial.location.wslDistro !== null ||
      initial.location.workspaceKind !== 'folder' ||
      initial.lease.runtimeFence !== binding.fence ||
      (initial.lease.reservedSpawnToken ?? initial.lease.ownerProcess?.spawnToken) !==
        binding.spawnToken ||
      dispatch.assignee_orca_session_id !== binding.sessionId
    ) {
      return refused()
    }
    const policy = structuredClone(initial.executionPolicy)
    const fingerprint = agentSessionExecutionPolicyFingerprint(policy)
    const task = db.getTask(dispatch.task_id)
    const readFingerprint = () =>
      workerStartOptionsExecutionPolicyFingerprint(
        db.getWorkerDispatch(dispatch.id)?.start_options ?? ''
      )
    if (!task || task.run_id !== dispatch.run_id || readFingerprint() !== fingerprint) {
      return refused()
    }
    let reported = false
    return async (input) => {
      const record = host.deps.store.getRecord(binding.sessionId)
      const receipt = agentSessionExecutionReceiptSchema.safeParse(record?.executionReceipt)
      const current = db.findActiveDispatchForAssignee(identity.handle, identity.paneKey)
      const generation = binding.currentGeneration()
      const parsed = agentSessionExecutionReportSchema.safeParse(input)
      if (
        reported ||
        !parsed.success ||
        getStructuredAgentSessionHost() !== host ||
        runtime.getOrchestrationDb() !== db ||
        !record?.executionPolicy ||
        record.lease.claimStatus !== 'live' ||
        record.lease.runtimeFence !== binding.fence ||
        record.lease.ownerProcess?.spawnToken !== binding.spawnToken ||
        !generation ||
        !receipt.success ||
        receipt.data.invalidated ||
        receipt.data.execution.acquisitionGeneration !== generation ||
        receipt.data.execution.runtimeFence !== binding.fence ||
        !receipt.data.execution.bounded?.inputAdmitted ||
        agentSessionExecutionPolicyFingerprint(record.executionPolicy) !== fingerprint ||
        (host.deps.now?.() ?? Date.now()) >= policy.deadlineAt ||
        db.getTask(dispatch.task_id)?.parent_id !== task.parent_id ||
        db.getTask(dispatch.task_id)?.run_id !== dispatch.run_id ||
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
      reported = true
      const report = parsed.data
      const result = sendPointToPointMessage({
        runtime,
        db,
        params: {
          from: identity.handle,
          subject: `Worker: ${report.status}`,
          type: 'worker_done',
          body: JSON.stringify({ source_pin: policy.sourcePin, ...report }),
          payload: JSON.stringify({
            taskId: dispatch.task_id,
            dispatchId: dispatch.id,
            outcome: report.status === 'succeeded' ? 'succeeded' : 'failed'
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
        typeof result !== 'object' ||
        result === null ||
        !('lifecycle' in result) ||
        typeof result.lifecycle !== 'object' ||
        result.lifecycle === null ||
        !('action' in result.lifecycle) ||
        (result.lifecycle.action !== 'completed' && result.lifecycle.action !== 'failed')
      ) {
        refused()
      }
    }
  }
}

export function createWorkerReportBindings(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'notifyMessageArrived' | 'getRuntimeId'>
) {
  return {
    prepareAdvisoryReporter: createAdvisoryReportPublisher(runtime),
    prepareExecutionReporter: createExecutionReportPublisher(runtime),
    executionRuntimeIdentity: () =>
      executionBuildHash === 'unknown'
        ? null
        : { runtimeId: runtime.getRuntimeId(), pid: process.pid, buildHash: executionBuildHash }
  }
}
