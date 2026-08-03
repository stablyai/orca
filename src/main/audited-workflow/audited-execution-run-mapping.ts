// Maps raw audited_execution_runs rows to the domain shape. Isolated from query
// logic so column-name drift is a one-file change, mirroring
// audited-task-row-mapping.ts.
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type {
  ExecutionMode,
  ExecutionReasonCode,
  ExecutionRunStatus
} from '../../shared/audited-execution-types'

export type AuditedExecutionRunRow = {
  id: string
  taskId: string
  mode: ExecutionMode
  status: ExecutionRunStatus
  // The state the task held BEFORE this run's start transition. Cancel restores
  // exactly this value — it is never inferred from the mode.
  preLaunchState: AuditedTaskState
  // The state this run lives in; written to pre_block_state on failure.
  activeRunState: AuditedTaskState
  reasonCode: ExecutionReasonCode | null
  exitCode: number | null
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  worktreeVerifiedAt: number
  startedAt: number
  endedAt: number | null
}

export function sqliteRowToExecutionRun(row: Record<string, unknown>): AuditedExecutionRunRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    mode: row.mode as ExecutionMode,
    status: row.status as ExecutionRunStatus,
    preLaunchState: row.pre_launch_state as AuditedTaskState,
    activeRunState: row.active_run_state as AuditedTaskState,
    reasonCode: (row.reason_code as ExecutionReasonCode | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    stdoutBytes: row.stdout_bytes as number,
    stderrBytes: row.stderr_bytes as number,
    outputTruncated: Boolean(row.output_truncated),
    worktreeVerifiedAt: row.worktree_verified_at_ms as number,
    startedAt: row.started_at_ms as number,
    endedAt: (row.ended_at_ms as number | null) ?? null
  }
}
