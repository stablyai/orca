export type DispatchTranscriptTerminalIdentity = {
  executionHostId: string
  workspaceKey: string
  terminalHandle: string
  paneKey: string
  ptyIncarnation: string
  processRootId: string | null
}

export type DispatchTranscriptSegment = DispatchTranscriptTerminalIdentity & {
  dispatchId: string
  leaseId: string
  runId: string
  taskId: string
  attemptId: string
  predecessorDispatchId: string | null
  startCursor: number
  endCursor: number | null
  createdAt: string
  updatedAt: string
}

export type DispatchTranscriptTransferReceipt = DispatchTranscriptTerminalIdentity & {
  version: 1
  requestId: string
  leaseTransferRequestId: string
  predecessorDispatchId: string
  predecessorLeaseId: string
  successorDispatchId: string
  successorLeaseId: string
  successorRunId: string
  successorTaskId: string
  successorAttemptId: string
  transferCursor: number
  transferredAt: string
}

export type DispatchTranscriptEntry = {
  dispatchId: string
  cursor: number
  payload: unknown
}

export type DispatchTranscriptReadSelector =
  | { kind: 'active' }
  | { kind: 'predecessor'; dispatchId: string }
  | { kind: 'all' }

export type DispatchTranscriptReadResult = {
  dispatchId: string
  selector: DispatchTranscriptReadSelector
  segments: DispatchTranscriptSegment[]
  entries: DispatchTranscriptEntry[]
  continuation: {
    cursor: string
    hasMore: boolean
    limit: number
    returnedCount: number
  }
}

export type StartDispatchTranscriptSegmentParams = DispatchTranscriptTerminalIdentity & {
  dispatchId: string
  leaseId: string
  runId: string
  taskId: string
  attemptId: string
  startCursor: number
}

export type TransferDispatchTranscriptSegmentParams = DispatchTranscriptTerminalIdentity & {
  requestId: string
  leaseTransferRequestId: string
  predecessorDispatchId: string
  predecessorLeaseId: string
  successorDispatchId: string
  successorLeaseId: string
  successorRunId: string
  successorTaskId: string
  successorAttemptId: string
  transferCursor: number
}
