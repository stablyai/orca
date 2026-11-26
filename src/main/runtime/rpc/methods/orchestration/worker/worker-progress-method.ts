import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ProgressParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { assertLifecycleCallerIsNotAnotherParty } from '../messaging/lifecycle-caller-fence'
import { assertWorkerCanReport } from '../../../../orchestration/workers/reports/worker-report-admission'
import { resolveWorkerReporterIdentity } from '../../../../orchestration/workers/reports/reminted-worker-reporter'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { exposeUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'

export type WorkerProgressResult = {
  dispatchId: string
  taskId: string
  runId: string | null
  note: string
  updatedAt: string
}

export const ORCHESTRATION_WORKER_PROGRESS_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.progress',
    access: {
      kind: 'writes',
      caller: 'from',
      callerPane: 'senderPaneKey',
      targets: {}
    },
    permission: 'workspace',
    params: ProgressParams,
    handler: (
      params,
      {
        runtime,
        recordMutationReceipt,
        orchestrationCaller,
        orchestrationCompatibilityCallerAuthority,
        orchestrationCompatibilityEvidence
      }
    ): WorkerProgressResult => {
      if (orchestrationCaller?.kind === 'peer') {
        throw new OrchestrationError(
          'forbidden',
          'orchestration progress records passive worker status on the worker host itself. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      const reporter = resolveWorkerReporterIdentity(runtime, db, {
        from,
        authority: orchestrationCompatibilityCallerAuthority,
        hasSessionCaller: Boolean(orchestrationCaller),
        evidence: orchestrationCompatibilityEvidence,
        candidateDispatchId: params.dispatchId
      })
      const paneKey = reporter.paneKey ?? params.senderPaneKey ?? undefined
      if (!orchestrationCaller) {
        assertLifecycleCallerIsNotAnotherParty(runtime, {
          from,
          fromPaneKey: paneKey,
          evidence: orchestrationCompatibilityEvidence
        })
      }

      const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (remoteAttachment && paneKey) {
        throw new OrchestrationError(
          'unsupported_remote_dispatch',
          `Passive progress notes are not supported for legacy remote-attached Dispatch ${remoteAttachment.dispatch_id}. No effects were applied.`,
          { effectsApplied: false }
        )
      }

      let workingDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      if (!workingDispatch && params.dispatchId) {
        const named = db.getDispatchContextById(params.dispatchId)
        if (!named) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Dispatch ${params.dispatchId} was not found. No effects were applied.`
          )
        }
        if (named.status !== 'dispatched') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${params.dispatchId} is ${named.status}; orchestration progress applies only while a worker Dispatch is active. Use orca orchestration send when a recipient must be woken.`
          )
        }
        if (!isDispatchAssignee(named, from, paneKey)) {
          throw new OrchestrationError(
            'sender_not_assignee',
            `Caller ${from} does not own active Dispatch ${params.dispatchId}.`
          )
        }
        workingDispatch = named
      }

      if (!workingDispatch) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'orchestration progress requires an active worker Dispatch; it records passive worker status without mailing anyone. Use orca orchestration send when a recipient must be woken.'
        )
      }

      if (params.dispatchId && params.dispatchId !== workingDispatch.id) {
        const named = db.getDispatchContextById(params.dispatchId)
        if (!named) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Dispatch ${params.dispatchId} was not found. No effects were applied.`
          )
        }
        if (named.status === 'dispatched' && !isDispatchAssignee(named, from, paneKey)) {
          throw new OrchestrationError(
            'sender_not_assignee',
            `Caller ${from} does not own active Dispatch ${params.dispatchId}.`
          )
        }
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${params.dispatchId} is not the active Dispatch (${workingDispatch.id}) for this worker.`
        )
      }

      assertWorkerCanReport({
        dispatchId: workingDispatch.id,
        from,
        workerState: db.getWorkerDispatch(workingDispatch.id)?.state,
        processCurrent:
          !workingDispatch.process_incarnation ||
          db.isDispatchProcessCurrent({
            dispatchId: workingDispatch.id,
            paneKey: paneKey ?? null,
            processIncarnation: reporter.processIncarnation()
          })
      })

      const updated = db.recordWorkerProgress({
        dispatchId: workingDispatch.id,
        note: params.note
      })
      const updatedAt =
        exposeUtcTimestamp(updated.progress_updated_at) ??
        updated.progress_updated_at ??
        new Date().toISOString()
      const receipt: WorkerProgressResult = {
        dispatchId: updated.id,
        taskId: updated.task_id,
        runId: updated.run_id,
        note: updated.progress_note ?? params.note,
        updatedAt
      }
      recordMutationReceipt?.(receipt)
      return receipt
    }
  })
]
