import { randomUUID } from 'node:crypto'
import type { WorkerReportInput } from '../../shared/worker-report-record'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { isWorkerStateIn, SETTLEABLE_WORKER_STATES } from './orchestration/worker-report-admission'
import type { OrcaRuntimeService } from './orca-runtime'

export function canReplayLocalWorkerReport(
  runtime: OrcaRuntimeService,
  input: WorkerReportInput
): boolean {
  const db = runtime.getOrchestrationDb()
  const paneKey = runtime.getTerminalPaneKey(input.params.from)
  if (paneKey && db.findActiveRemoteAttachmentForPane(paneKey)) {
    return false
  }
  const receipt = db.getMutationReceipt(
    db.getOrCreateLocalMutationCallerFingerprint(),
    input.requestId
  )
  if (receipt?.state === 'completed') {
    return true
  }
  const target = JSON.parse(input.params.payload)
  const dispatch = db.getDispatchContextById(target.dispatchId)
  if (!dispatch || dispatch.task_id !== target.taskId) {
    return false
  }
  // An expired receipt cannot prove whether a finished Dispatch already received this report.
  if (!isWorkerStateIn(SETTLEABLE_WORKER_STATES, db.getWorkerDispatch(dispatch.id)?.state)) {
    return false
  }
  const incarnation = runtime.getTerminalProcessIncarnation(input.params.from)
  // Startup absence and a replacement process cannot authorize the original report.
  return Boolean(
    paneKey &&
    incarnation &&
    dispatch.assignee_pane_key === paneKey &&
    dispatch.process_incarnation === incarnation
  )
}

export async function replayWorkerReport(
  input: WorkerReportInput,
  local: (request: string) => Promise<RuntimeRpcResponse<unknown>>,
  authToken: string
): Promise<RuntimeRpcResponse<unknown>> {
  return local(
    JSON.stringify({
      id: randomUUID(),
      authToken,
      method: 'orchestration.send',
      params: input.params,
      ...input.envelope
    })
  )
}
