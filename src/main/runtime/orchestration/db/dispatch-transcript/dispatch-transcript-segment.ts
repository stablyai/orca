import type {
  DispatchTranscriptSegment,
  DispatchTranscriptTerminalIdentity,
  DispatchTranscriptTransferReceipt,
  StartDispatchTranscriptSegmentParams,
  TransferDispatchTranscriptSegmentParams
} from './dispatch-transcript-types'
import { OrchestrationError } from '../../orchestration-error'

export type DispatchTranscriptSegmentRow = {
  dispatch_id: string
  lease_id: string
  run_id: string
  task_id: string
  attempt_id: string
  predecessor_dispatch_id: string | null
  execution_host_id: string
  workspace_key: string
  terminal_handle: string
  pane_key: string
  pty_incarnation: string
  process_root_id: string | null
  start_cursor: number
  end_cursor: number | null
  created_at: string
  updated_at: string
}

export function deserializeDispatchTranscriptSegment(
  row: DispatchTranscriptSegmentRow
): DispatchTranscriptSegment {
  return {
    dispatchId: row.dispatch_id,
    leaseId: row.lease_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    predecessorDispatchId: row.predecessor_dispatch_id,
    executionHostId: row.execution_host_id,
    workspaceKey: row.workspace_key,
    terminalHandle: row.terminal_handle,
    paneKey: row.pane_key,
    ptyIncarnation: row.pty_incarnation,
    processRootId: row.process_root_id,
    startCursor: row.start_cursor,
    endCursor: row.end_cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function matchesStartedSegment(
  segment: DispatchTranscriptSegment,
  params: StartDispatchTranscriptSegmentParams
): boolean {
  return (
    segment.leaseId === params.leaseId &&
    segment.runId === params.runId &&
    segment.taskId === params.taskId &&
    segment.attemptId === params.attemptId &&
    segment.predecessorDispatchId === null &&
    segment.startCursor === params.startCursor &&
    matchesTerminalIdentity(segment, params)
  )
}

export function matchesTerminalIdentity(
  left: DispatchTranscriptTerminalIdentity,
  right: DispatchTranscriptTerminalIdentity
): boolean {
  return (
    left.executionHostId === right.executionHostId &&
    left.workspaceKey === right.workspaceKey &&
    left.terminalHandle === right.terminalHandle &&
    left.paneKey === right.paneKey &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.processRootId === right.processRootId
  )
}

export function matchesTransferRequest(
  receipt: DispatchTranscriptTransferReceipt,
  params: TransferDispatchTranscriptSegmentParams
): boolean {
  return (
    receipt.requestId === params.requestId &&
    receipt.leaseTransferRequestId === params.leaseTransferRequestId &&
    receipt.predecessorDispatchId === params.predecessorDispatchId &&
    receipt.predecessorLeaseId === params.predecessorLeaseId &&
    receipt.successorDispatchId === params.successorDispatchId &&
    receipt.successorLeaseId === params.successorLeaseId &&
    receipt.successorRunId === params.successorRunId &&
    receipt.successorTaskId === params.successorTaskId &&
    receipt.successorAttemptId === params.successorAttemptId &&
    receipt.transferCursor === params.transferCursor &&
    matchesTerminalIdentity(receipt, params)
  )
}

export function assertDispatchTranscriptCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new OrchestrationError('invalid_argument', 'Transcript cursor must be non-negative.')
  }
}
