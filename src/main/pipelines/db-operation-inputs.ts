import type {
  PipelineIterationStatus,
  PipelineLogLevel,
  PipelinePrdWorkSetKey,
  PipelineRecoveryReportSummary,
  PipelineStageName,
  PipelineStageStatus,
  PipelineTaskRecordSourceType,
  PipelineTaskStatus
} from '../../shared/pipelines-types'

export type CreatePipelineIterationInput = {
  runId: string
  iterationNumber: number
  status?: PipelineIterationStatus
  plannerTerminalId?: string | null
  plannerWorktreeId?: string | null
  coordinatorRunId?: string | null
  plannerOutput?: unknown
}

export type CreatePipelineTaskInput = {
  runId: string
  iterationId: string
  sourceType: PipelineTaskRecordSourceType
  sourceId: string
  title: string
  branch: string
  status?: PipelineTaskStatus
  blockedBy?: string[]
  orchestrationTaskId?: string | null
  worktreeId?: string | null
  terminalIds?: string[]
  commitShas?: string[]
  result?: unknown
  issueClosure?: unknown
}

export type UpdatePipelineTaskDispatchLinkInput = {
  orchestrationTaskId: string
  worktreeId: string
}

export type UpdatePipelineTaskCommitShasInput = {
  commitShas: string[]
}

export type UpdatePipelineTaskIssueClosureInput = {
  issueClosure: unknown
}

export type CreatePipelineStageInput = {
  runId: string
  iterationId?: string | null
  taskId?: string | null
  stage: PipelineStageName
  status?: PipelineStageStatus
  worktreeId?: string | null
  terminalId?: string | null
}

export type UpdatePipelineStageOptions = {
  outputSnapshot?: string | null
  error?: unknown
}

export type UpdatePipelineStageExecutionRefsInput = {
  terminalId?: string | null
  worktreeId?: string | null
}

export type UpdatePipelineIterationPlannerResultInput = {
  plannerTerminalId?: string | null
  plannerWorktreeId?: string | null
  plannerOutput?: unknown
}

export type AppendPipelineLogInput = {
  runId: string
  iterationId?: string | null
  taskId?: string | null
  stageId?: string | null
  level?: PipelineLogLevel
  message: string
  payload?: unknown
}

export type RecordPipelineDynamicContextResultInput = {
  runId: string
  stageId?: string | null
  templateId: string
  command: string
  cwd: string
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type CreatePipelineActiveRunReservationInput = PipelinePrdWorkSetKey & {
  runId: string
}

export type CreatePipelineRecoveryReportInput = PipelinePrdWorkSetKey & {
  interruptedRunId: string
  summary: PipelineRecoveryReportSummary
}
