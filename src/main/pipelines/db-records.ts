import type {
  PipelineDynamicContextResult,
  PipelineError,
  PipelineIteration,
  PipelineIterationStatus,
  PipelineLogEntry,
  PipelineLogLevel,
  PipelineRun,
  PipelineRunStatusReason,
  PipelineRunStatus,
  PipelineStage,
  PipelineStageName,
  PipelineStageStatus,
  PipelineTask,
  PipelineTaskRecordSourceType,
  PipelineTaskSource,
  PipelineTaskStatus,
  PipelineVerifierConfig
} from '../../shared/pipelines-types'
import type { TuiAgent } from '../../shared/types'

export type PipelineRunRecord = {
  id: string
  template_id: string
  repo_id: string
  source_branch: string
  target_branch: string
  task_source_json: string
  status: PipelineRunStatus
  status_reason: PipelineRunStatusReason | null
  max_concurrent: number
  max_iterations: number
  current_iteration: number
  planner_agent_id: string
  implementer_agent_id: string
  reviewer_agent_id: string | null
  merger_agent_id: string
  verifier_json: string | null
  execution_target_type: 'local' | 'ssh'
  execution_target_id: string | null
  automation_run_id: string | null
  replaces_run_id: string | null
  recovery_report_id: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  error_json: string | null
}

export type PipelineIterationRecord = {
  id: string
  run_id: string
  iteration_number: number
  status: PipelineIterationStatus
  planner_terminal_id: string | null
  planner_worktree_id: string | null
  coordinator_run_id: string | null
  planner_output_json: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  error_json: string | null
}

export type PipelineTaskRecord = {
  id: string
  run_id: string
  iteration_id: string
  source_type: PipelineTaskRecordSourceType
  source_id: string
  title: string
  branch: string
  status: PipelineTaskStatus
  blocked_by_json: string
  orchestration_task_id: string | null
  worktree_id: string | null
  terminal_ids_json: string
  commit_shas_json: string
  result_json: string | null
  issue_closure_json: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  error_json: string | null
}

export type PipelineStageRecord = {
  id: string
  run_id: string
  iteration_id: string | null
  task_id: string | null
  stage: PipelineStageName
  status: PipelineStageStatus
  worktree_id: string | null
  terminal_id: string | null
  started_at: string | null
  completed_at: string | null
  output_snapshot: string | null
  error_json: string | null
}

export type PipelineLogRecord = {
  id: string
  run_id: string
  iteration_id: string | null
  task_id: string | null
  stage_id: string | null
  level: PipelineLogLevel
  message: string
  payload_json: string | null
  created_at: string
}

export type PipelineDynamicContextResultRecord = {
  id: string
  run_id: string
  stage_id: string | null
  template_id: string
  command: string
  cwd: string
  exit_code: number | null
  timed_out: number
  stdout: string
  stderr: string
  stdout_truncated: number
  stderr_truncated: number
  created_at: string
  completed_at: string | null
}

export function toJsonText(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback
  }
  return JSON.parse(value) as T
}

export function toPipelineRun(row: PipelineRunRecord): PipelineRun {
  return {
    id: row.id,
    templateId: row.template_id,
    repoId: row.repo_id,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    taskSource: parseJson<PipelineTaskSource>(row.task_source_json, { type: 'manual', tasks: [] }),
    status: row.status,
    statusReason: row.status_reason,
    maxConcurrent: row.max_concurrent,
    maxIterations: row.max_iterations,
    currentIteration: row.current_iteration,
    plannerAgentId: row.planner_agent_id as TuiAgent,
    implementerAgentId: row.implementer_agent_id as TuiAgent,
    reviewerAgentId: row.reviewer_agent_id as TuiAgent | null,
    mergerAgentId: row.merger_agent_id as TuiAgent,
    verifier: parseJson<PipelineVerifierConfig | null>(row.verifier_json, null),
    executionTargetType: row.execution_target_type,
    executionTargetId: row.execution_target_id,
    automationRunId: row.automation_run_id,
    replacesRunId: row.replaces_run_id,
    recoveryReportId: row.recovery_report_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: parseJson<PipelineError | null>(row.error_json, null)
  }
}

export function toPipelineIteration(row: PipelineIterationRecord): PipelineIteration {
  return {
    id: row.id,
    runId: row.run_id,
    iterationNumber: row.iteration_number,
    status: row.status,
    plannerTerminalId: row.planner_terminal_id,
    plannerWorktreeId: row.planner_worktree_id,
    coordinatorRunId: row.coordinator_run_id,
    plannerOutput: parseJson<unknown>(row.planner_output_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: parseJson<PipelineError | null>(row.error_json, null)
  }
}

export function toPipelineTask(row: PipelineTaskRecord): PipelineTask {
  return {
    id: row.id,
    runId: row.run_id,
    iterationId: row.iteration_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    branch: row.branch,
    status: row.status,
    blockedBy: parseJson<string[]>(row.blocked_by_json, []),
    orchestrationTaskId: row.orchestration_task_id,
    worktreeId: row.worktree_id,
    terminalIds: parseJson<string[]>(row.terminal_ids_json, []),
    commitShas: parseJson<string[]>(row.commit_shas_json, []),
    result: parseJson<unknown>(row.result_json, null),
    issueClosure: parseJson<unknown>(row.issue_closure_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: parseJson<PipelineError | null>(row.error_json, null)
  }
}

export function toPipelineStage(row: PipelineStageRecord): PipelineStage {
  return {
    id: row.id,
    runId: row.run_id,
    iterationId: row.iteration_id,
    taskId: row.task_id,
    stage: row.stage,
    status: row.status,
    worktreeId: row.worktree_id,
    terminalId: row.terminal_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outputSnapshot: row.output_snapshot,
    error: parseJson<PipelineError | null>(row.error_json, null)
  }
}

export function toPipelineLogEntry(row: PipelineLogRecord): PipelineLogEntry {
  return {
    id: row.id,
    runId: row.run_id,
    iterationId: row.iteration_id,
    taskId: row.task_id,
    stageId: row.stage_id,
    level: row.level,
    message: row.message,
    payload: parseJson<unknown>(row.payload_json, null),
    createdAt: row.created_at
  }
}

export function toPipelineDynamicContextResult(
  row: PipelineDynamicContextResultRecord
): PipelineDynamicContextResult {
  return {
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    templateId: row.template_id,
    command: row.command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    stdout: row.stdout,
    stderr: row.stderr,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}
