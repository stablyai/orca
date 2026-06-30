import Database from '../sqlite/sync-database'
import type {
  AppendPipelineLogInput,
  CreatePipelineIterationInput,
  CreatePipelineStageInput,
  CreatePipelineTaskInput,
  RecordPipelineDynamicContextResultInput,
  CreatePipelineActiveRunReservationInput,
  CreatePipelineRecoveryReportInput,
  UpdatePipelineIterationPlannerResultInput,
  UpdatePipelineStageExecutionRefsInput,
  UpdatePipelineStageOptions,
  UpdatePipelineTaskCommitShasInput,
  UpdatePipelineTaskDispatchLinkInput,
  UpdatePipelineTaskIssueClosureInput
} from './db-operation-inputs'
import {
  createPipelineIteration,
  createPipelineTask,
  updatePipelineIterationPlannerResult,
  updatePipelineTaskCommitShas,
  updatePipelineTaskDispatchLink,
  updatePipelineTaskIssueClosure,
  updatePipelineIterationStatus,
  updatePipelineTaskStatus
} from './db-iteration-task-operations'
import {
  getPipelineIteration,
  getPipelineRun,
  getPipelineRunDetail,
  getPipelineStage,
  getPipelineTask,
  listPipelineDynamicContextResults,
  listPipelineLogs,
  listPipelineRuns
} from './db-read-queries'
import {
  cancelPipelineRun,
  cancelPipelineRunWithReason,
  createPipelineRun,
  updatePipelineRunStatus
} from './db-run-operations'
import {
  acknowledgePipelineRecoveryReport,
  createPipelineActiveRunReservation,
  createPipelineRecoveryReport,
  getActivePipelineRunReservation,
  getLatestPendingPipelineRecoveryReport,
  getPipelineActiveRunReservationById,
  getPipelineRecoveryReport,
  listPipelineRecoveryReports,
  refreshPipelineActiveRunReservation,
  releasePipelineActiveRunReservation
} from './db-reservation-recovery-operations'
import {
  appendPipelineLog,
  createPipelineStage,
  recordPipelineDynamicContextResult,
  updatePipelineStageExecutionRefs,
  updatePipelineStageStatus
} from './db-stage-log-operations'
import { PIPELINE_CREATE_TABLES_SQL, PIPELINE_SCHEMA_VERSION } from './schema'
import type {
  PipelineDynamicContextResult,
  PipelineActiveRunReservation,
  PipelineIteration,
  PipelineIterationStatus,
  PipelineLogEntry,
  PipelinePrdWorkSetKey,
  PipelineRecoveryReport,
  PipelineRecoveryReportStatus,
  PipelineRun,
  PipelineRunDetail,
  PipelineRunInput,
  PipelineRunStatus,
  PipelineStage,
  PipelineStageStatus,
  PipelineTask,
  PipelineTaskStatus
} from '../../shared/pipelines-types'

export class PipelineDb {
  private db: Database.Database

  constructor(dbPath: string | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.createTables()
    this.migrate()
  }

  private createTables(): void {
    this.db.exec(PIPELINE_CREATE_TABLES_SQL)
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    if (current >= PIPELINE_SCHEMA_VERSION) {
      return
    }
    this.db.pragma(`user_version = ${PIPELINE_SCHEMA_VERSION}`)
  }

  createRun(
    input: PipelineRunInput,
    options: {
      automationRunId?: string | null
      replacesRunId?: string | null
      recoveryReportId?: string | null
    } = {}
  ): PipelineRun {
    return createPipelineRun(this.db, input, options)
  }

  listRuns(
    filter: { repoId?: string; status?: PipelineRunStatus; limit?: number } = {}
  ): PipelineRun[] {
    return listPipelineRuns(this.db, filter)
  }

  getRun(id: string): PipelineRun | undefined {
    return getPipelineRun(this.db, id)
  }

  getRunDetail(runId: string): PipelineRunDetail | undefined {
    return getPipelineRunDetail(this.db, runId)
  }

  updateRunStatus(id: string, status: PipelineRunStatus, error?: unknown): PipelineRun | undefined {
    return updatePipelineRunStatus(this.db, id, status, error)
  }

  cancelRun(runId: string): PipelineRun {
    return cancelPipelineRun(this.db, runId)
  }

  cancelRunForPrdClosed(runId: string): PipelineRun {
    return cancelPipelineRunWithReason(this.db, runId, 'prd_closed')
  }

  createActiveRunReservation(
    input: CreatePipelineActiveRunReservationInput
  ): PipelineActiveRunReservation {
    return createPipelineActiveRunReservation(this.db, input)
  }

  getActiveRunReservation(input: PipelinePrdWorkSetKey): PipelineActiveRunReservation | undefined {
    return getActivePipelineRunReservation(this.db, input)
  }

  getActiveRunReservationById(id: string): PipelineActiveRunReservation | undefined {
    return getPipelineActiveRunReservationById(this.db, id)
  }

  releaseActiveRunReservation(
    id: string,
    reason: string
  ): PipelineActiveRunReservation | undefined {
    return releasePipelineActiveRunReservation(this.db, id, reason)
  }

  refreshActiveRunReservation(id: string): PipelineActiveRunReservation | undefined {
    return refreshPipelineActiveRunReservation(this.db, id)
  }

  createRecoveryReport(input: CreatePipelineRecoveryReportInput): PipelineRecoveryReport {
    return createPipelineRecoveryReport(this.db, input)
  }

  getRecoveryReport(id: string): PipelineRecoveryReport | undefined {
    return getPipelineRecoveryReport(this.db, id)
  }

  listRecoveryReports(
    filter: {
      repoId?: string
      prdIssueNumber?: number
      status?: PipelineRecoveryReportStatus
    } = {}
  ): PipelineRecoveryReport[] {
    return listPipelineRecoveryReports(this.db, filter)
  }

  getLatestPendingRecoveryReport(input: PipelinePrdWorkSetKey): PipelineRecoveryReport | undefined {
    return getLatestPendingPipelineRecoveryReport(this.db, input)
  }

  acknowledgeRecoveryReport(id: string): PipelineRecoveryReport | undefined {
    return acknowledgePipelineRecoveryReport(this.db, id)
  }

  createIteration(input: CreatePipelineIterationInput): PipelineIteration {
    return createPipelineIteration(this.db, input)
  }

  getIteration(id: string): PipelineIteration | undefined {
    return getPipelineIteration(this.db, id)
  }

  updateIterationStatus(
    id: string,
    status: PipelineIterationStatus,
    error?: unknown
  ): PipelineIteration | undefined {
    return updatePipelineIterationStatus(this.db, id, status, error)
  }

  updateIterationPlannerResult(
    id: string,
    input: UpdatePipelineIterationPlannerResultInput
  ): PipelineIteration | undefined {
    return updatePipelineIterationPlannerResult(this.db, id, input)
  }

  createTask(input: CreatePipelineTaskInput): PipelineTask {
    return createPipelineTask(this.db, input)
  }

  getTask(id: string): PipelineTask | undefined {
    return getPipelineTask(this.db, id)
  }

  updateTaskStatus(
    id: string,
    status: PipelineTaskStatus,
    error?: unknown
  ): PipelineTask | undefined {
    return updatePipelineTaskStatus(this.db, id, status, error)
  }

  updateTaskDispatchLink(
    id: string,
    input: UpdatePipelineTaskDispatchLinkInput
  ): PipelineTask | undefined {
    return updatePipelineTaskDispatchLink(this.db, id, input)
  }

  updateTaskCommitShas(
    id: string,
    input: UpdatePipelineTaskCommitShasInput
  ): PipelineTask | undefined {
    return updatePipelineTaskCommitShas(this.db, id, input)
  }

  updateTaskIssueClosure(
    id: string,
    input: UpdatePipelineTaskIssueClosureInput
  ): PipelineTask | undefined {
    return updatePipelineTaskIssueClosure(this.db, id, input)
  }

  createStage(input: CreatePipelineStageInput): PipelineStage {
    return createPipelineStage(this.db, input)
  }

  getStage(id: string): PipelineStage | undefined {
    return getPipelineStage(this.db, id)
  }

  updateStageStatus(
    id: string,
    status: PipelineStageStatus,
    options: UpdatePipelineStageOptions = {}
  ): PipelineStage | undefined {
    return updatePipelineStageStatus(this.db, id, status, options)
  }

  updateStageExecutionRefs(
    id: string,
    input: UpdatePipelineStageExecutionRefsInput
  ): PipelineStage | undefined {
    return updatePipelineStageExecutionRefs(this.db, id, input)
  }

  appendLog(input: AppendPipelineLogInput): PipelineLogEntry {
    return appendPipelineLog(this.db, input)
  }

  listLogs(filter: {
    runId: string
    stageId?: string
    taskId?: string
    limit?: number
  }): PipelineLogEntry[] {
    return listPipelineLogs(this.db, filter)
  }

  recordDynamicContextResult(
    input: RecordPipelineDynamicContextResultInput
  ): PipelineDynamicContextResult {
    return recordPipelineDynamicContextResult(this.db, input)
  }

  listDynamicContextResults(runId: string): PipelineDynamicContextResult[] {
    return listPipelineDynamicContextResults(this.db, runId)
  }

  close(): void {
    this.db.close()
  }
}
