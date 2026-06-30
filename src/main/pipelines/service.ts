import type { PipelineDb } from './db'
import {
  type PipelineGitHubCommandRunner,
  listPipelinePrdCandidates,
  runGitHubCli
} from './prd-candidates'
import {
  type PipelineTemplateRegistry,
  createBuiltInPipelineTemplateRegistry
} from './template-registry'
import { validatePipelinePrdLabel } from '../../shared/pipeline-prd-work-set'
import type {
  PipelineActiveRunReservation,
  PipelineLogEntry,
  PipelinePrdCandidate,
  PipelinePrdWorkSetKey,
  PipelineRecoveryReport,
  PipelineRecoveryReportStatus,
  PipelineRun,
  PipelineRunDetail,
  PipelineRunInput,
  PipelineRunStatus
} from '../../shared/pipelines-types'
import type { PipelineTemplateSummary } from '../../shared/pipeline-template-types'

export type PipelineRunExecutorInput = {
  db: PipelineDb
  templates: PipelineTemplateRegistry
  run: PipelineRun
}

export type PipelineRunExecutor = (input: PipelineRunExecutorInput) => Promise<void>

export type PipelineListFilter = {
  repoId?: string
  status?: PipelineRunStatus
  limit?: number
}

export type PipelineRunOptions = {
  automationRunId?: string | null
  replacesRunId?: string | null
  recoveryReportId?: string | null
}

export class PipelineService {
  readonly db: PipelineDb
  private readonly templates: PipelineTemplateRegistry
  private readonly executor: PipelineRunExecutor | null
  private readonly githubCommandRunner: PipelineGitHubCommandRunner
  private readonly executions = new Map<string, Promise<void>>()

  constructor(input: {
    db: PipelineDb
    templates?: PipelineTemplateRegistry
    executor?: PipelineRunExecutor
    githubCommandRunner?: PipelineGitHubCommandRunner
  }) {
    this.db = input.db
    this.templates = input.templates ?? createBuiltInPipelineTemplateRegistry()
    this.executor = input.executor ?? null
    this.githubCommandRunner = input.githubCommandRunner ?? runGitHubCli
  }

  templateList(): { templates: PipelineTemplateSummary[] } {
    return { templates: this.templates.listTemplates() }
  }

  run(input: PipelineRunInput, options: PipelineRunOptions = {}): { run: PipelineRun } {
    const resolvedInput = normalizePipelineRunInput(input, this.templates)
    const workSet = getPipelineWorkSetKey(resolvedInput)
    const runOptions = this.resolveRunOptions(workSet, options)
    this.assertCanStartRun(workSet)
    const run = this.db.createRun(resolvedInput, runOptions)
    this.db.createActiveRunReservation({ ...workSet, runId: run.id })
    this.startExecution(run)
    return { run }
  }

  list(filter: PipelineListFilter = {}): { runs: PipelineRun[] } {
    return { runs: this.db.listRuns(filter) }
  }

  show(runId: string): PipelineRunDetail {
    const detail = this.db.getRunDetail(runId)
    if (!detail) {
      throw new Error(`Pipeline run not found: ${runId}`)
    }
    return detail
  }

  cancel(runId: string): { run: PipelineRun } {
    const run = this.db.cancelRun(runId)
    this.releaseReservationForRun(run, 'cancelled')
    return { run }
  }

  logs(filter: { runId: string; stageId?: string; taskId?: string; limit?: number }): {
    logs: PipelineLogEntry[]
  } {
    return { logs: this.db.listLogs(filter) }
  }

  releaseStaleReservation(input: { reservationId: string; confirm: true }): {
    released: true
    reservation: PipelineActiveRunReservation | undefined
  } {
    return {
      released: true,
      reservation: this.db.releaseActiveRunReservation(input.reservationId, 'stale_confirmed')
    }
  }

  async prdCandidates(filter: {
    repoId: string
    owner: string
    repo: string
    limit?: number
    since?: string
  }): Promise<{ candidates: PipelinePrdCandidate[] }> {
    return {
      candidates: await listPipelinePrdCandidates({
        db: this.db,
        githubCommandRunner: this.githubCommandRunner,
        repoId: filter.repoId,
        owner: filter.owner,
        repo: filter.repo,
        limit: filter.limit
      })
    }
  }

  recoveryReportList(
    filter: {
      repoId?: string
      prdIssueNumber?: number
      status?: PipelineRecoveryReportStatus
    } = {}
  ): { reports: PipelineRecoveryReport[] } {
    return { reports: this.db.listRecoveryReports(filter) }
  }

  recoveryReportAcknowledge(reportId: string): { report: PipelineRecoveryReport } {
    const report = this.db.acknowledgeRecoveryReport(reportId)
    if (!report) {
      throw new Error(`Pipeline recovery report not found: ${reportId}`)
    }
    return { report }
  }

  waitForRunExecution(runId: string): Promise<void> {
    return this.executions.get(runId) ?? Promise.resolve()
  }

  private startExecution(run: PipelineRun): void {
    if (!this.executor) {
      return
    }
    // Why: RPC callers need the run id immediately; executor failures are
    // captured in Pipeline DB state instead of surfacing as unhandled promises.
    const execution = Promise.resolve()
      .then(() => this.executor!({ db: this.db, templates: this.templates, run }))
      .catch((error: unknown) => {
        const serialized = serializeExecutorError(error)
        this.db.updateRunStatus(run.id, 'failed', serialized)
        this.db.appendLog({
          runId: run.id,
          level: 'error',
          message: serialized.message,
          payload: serialized
        })
      })
      .finally(() => {
        const latest = this.db.getRun(run.id) ?? run
        if (isPipelineRunTerminal(latest.status)) {
          this.releaseReservationForRun(latest, latest.status)
        }
        this.executions.delete(run.id)
      })
    this.executions.set(run.id, execution)
  }

  private assertCanStartRun(workSet: PipelinePrdWorkSetKey): void {
    const active = this.db.getActiveRunReservation(workSet)
    if (active) {
      throw new Error(`An active Pipeline run reservation already exists: ${active.runId}`)
    }
    const recovery = this.db.getLatestPendingRecoveryReport(workSet)
    if (recovery) {
      throw new Error(`Pipeline work set has a pending recovery report: ${recovery.id}`)
    }
  }

  private resolveRunOptions(
    workSet: PipelinePrdWorkSetKey,
    options: PipelineRunOptions
  ): PipelineRunOptions {
    if (!options.recoveryReportId) {
      return options
    }
    const report = this.db.getRecoveryReport(options.recoveryReportId)
    if (!report) {
      throw new Error(`Pipeline recovery report not found: ${options.recoveryReportId}`)
    }
    if (report.status !== 'acknowledged') {
      throw new Error(`Pipeline recovery report must be acknowledged: ${report.id}`)
    }
    if (report.replacementRunId) {
      throw new Error(`Pipeline recovery report already has replacement run: ${report.id}`)
    }
    if (!samePipelineWorkSet(workSet, report)) {
      throw new Error(`Pipeline recovery report does not match PRD work set: ${report.id}`)
    }
    return {
      ...options,
      replacesRunId: options.replacesRunId ?? report.interruptedRunId,
      recoveryReportId: report.id
    }
  }

  private releaseReservationForRun(run: PipelineRun, reason: string): void {
    if (run.taskSource.type !== 'github_issues') {
      return
    }
    const reservation = this.db.getActiveRunReservation(getPipelineWorkSetKey(run))
    if (reservation?.runId === run.id) {
      this.db.releaseActiveRunReservation(reservation.id, reason)
    }
  }
}

function normalizePipelineRunInput(
  input: PipelineRunInput,
  templates: PipelineTemplateRegistry
): PipelineRunInput {
  if (input.taskSource.type !== 'github_issues') {
    throw new Error('Pipeline v1 run input must use github_issues task source')
  }
  validatePipelinePrdLabel(input.taskSource.prdIssueNumber, input.taskSource.pipelinePrdLabel)
  const template = templates.getTemplate(input.templateId)
  if (template?.id === 'sequential-reviewer') {
    return { ...input, maxConcurrent: 1 }
  }
  return input
}

function getPipelineWorkSetKey(input: PipelineRunInput | PipelineRun): PipelinePrdWorkSetKey {
  if (input.taskSource.type !== 'github_issues') {
    throw new Error('Pipeline v1 run input must use github_issues task source')
  }
  return {
    repoId: input.repoId,
    providerOwner: input.taskSource.owner,
    providerRepo: input.taskSource.repo,
    prdIssueNumber: input.taskSource.prdIssueNumber,
    pipelinePrdLabel: input.taskSource.pipelinePrdLabel
  }
}

function samePipelineWorkSet(left: PipelinePrdWorkSetKey, right: PipelinePrdWorkSetKey): boolean {
  return (
    left.repoId === right.repoId &&
    left.providerOwner === right.providerOwner &&
    left.providerRepo === right.providerRepo &&
    left.prdIssueNumber === right.prdIssueNumber &&
    left.pipelinePrdLabel === right.pipelinePrdLabel
  )
}

function isPipelineRunTerminal(status: PipelineRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

function serializeExecutorError(error: unknown): {
  message: string
  code?: string
  details?: unknown
} {
  if (error instanceof Error) {
    return { message: error.message }
  }
  return { message: String(error) }
}
