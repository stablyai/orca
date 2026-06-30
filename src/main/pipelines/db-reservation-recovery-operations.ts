import type Database from '../sqlite/sync-database'
import { generatePipelineId } from './db-identifiers'
import type {
  CreatePipelineActiveRunReservationInput,
  CreatePipelineRecoveryReportInput
} from './db-operation-inputs'
import type {
  PipelineActiveRunReservationRecord,
  PipelineRecoveryReportRecord
} from './db-reservation-recovery-records'
import {
  toPipelineActiveRunReservation,
  toPipelineRecoveryReport
} from './db-reservation-recovery-records'
import type {
  PipelineActiveRunReservation,
  PipelinePrdWorkSetKey,
  PipelineRecoveryReport,
  PipelineRecoveryReportStatus
} from '../../shared/pipelines-types'

export function createPipelineActiveRunReservation(
  db: Database.Database,
  input: CreatePipelineActiveRunReservationInput
): PipelineActiveRunReservation {
  const id = generatePipelineId('pipe_res')
  try {
    db.prepare(
      `INSERT INTO pipeline_active_run_reservations (
        id, run_id, repo_id, provider_owner, provider_repo,
        prd_issue_number, pipeline_prd_label
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.runId,
      input.repoId,
      input.providerOwner,
      input.providerRepo,
      input.prdIssueNumber,
      input.pipelinePrdLabel
    )
  } catch (error) {
    if (isSqliteUniqueError(error)) {
      throw new Error('An active Pipeline run reservation already exists for this PRD work set.')
    }
    throw error
  }
  return getPipelineActiveRunReservationById(db, id)!
}

export function getActivePipelineRunReservation(
  db: Database.Database,
  input: PipelinePrdWorkSetKey
): PipelineActiveRunReservation | undefined {
  const row = db
    .prepare(
      `${reservationSelectSql()}
       WHERE r.status = 'active'
         AND r.repo_id = ?
         AND r.provider_owner = ?
         AND r.provider_repo = ?
         AND r.prd_issue_number = ?
         AND r.pipeline_prd_label = ?`
    )
    .get(
      input.repoId,
      input.providerOwner,
      input.providerRepo,
      input.prdIssueNumber,
      input.pipelinePrdLabel
    ) as PipelineActiveRunReservationRecord | undefined
  return row ? toPipelineActiveRunReservation(row) : undefined
}

export function getPipelineActiveRunReservationById(
  db: Database.Database,
  id: string
): PipelineActiveRunReservation | undefined {
  const row = db.prepare(`${reservationSelectSql()} WHERE r.id = ?`).get(id) as
    | PipelineActiveRunReservationRecord
    | undefined
  return row ? toPipelineActiveRunReservation(row) : undefined
}

export function releasePipelineActiveRunReservation(
  db: Database.Database,
  id: string,
  reason: string
): PipelineActiveRunReservation | undefined {
  db.prepare(
    `UPDATE pipeline_active_run_reservations
     SET status = 'released',
         released_at = COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         release_reason = COALESCE(release_reason, ?),
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'active'`
  ).run(reason, id)
  return getPipelineActiveRunReservationById(db, id)
}

export function refreshPipelineActiveRunReservation(
  db: Database.Database,
  id: string
): PipelineActiveRunReservation | undefined {
  db.prepare(
    `UPDATE pipeline_active_run_reservations
     SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'active'`
  ).run(id)
  return getPipelineActiveRunReservationById(db, id)
}

export function createPipelineRecoveryReport(
  db: Database.Database,
  input: CreatePipelineRecoveryReportInput
): PipelineRecoveryReport {
  const id = generatePipelineId('pipe_recovery')
  db.prepare(
    `INSERT INTO pipeline_recovery_reports (
      id, interrupted_run_id, repo_id, provider_owner, provider_repo,
      prd_issue_number, pipeline_prd_label, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.interruptedRunId,
    input.repoId,
    input.providerOwner,
    input.providerRepo,
    input.prdIssueNumber,
    input.pipelinePrdLabel,
    JSON.stringify(input.summary)
  )
  return getPipelineRecoveryReport(db, id)!
}

export function getPipelineRecoveryReport(
  db: Database.Database,
  id: string
): PipelineRecoveryReport | undefined {
  const row = db.prepare('SELECT * FROM pipeline_recovery_reports WHERE id = ?').get(id) as
    | PipelineRecoveryReportRecord
    | undefined
  return row ? toPipelineRecoveryReport(row) : undefined
}

export function listPipelineRecoveryReports(
  db: Database.Database,
  filter: {
    repoId?: string
    prdIssueNumber?: number
    status?: PipelineRecoveryReportStatus
  } = {}
): PipelineRecoveryReport[] {
  const clauses: string[] = []
  const params: Database.BindValue[] = []
  if (filter.repoId) {
    clauses.push('repo_id = ?')
    params.push(filter.repoId)
  }
  if (filter.prdIssueNumber) {
    clauses.push('prd_issue_number = ?')
    params.push(filter.prdIssueNumber)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT * FROM pipeline_recovery_reports ${where} ORDER BY created_at DESC, rowid DESC`
    )
    .all(...params)
    .map((row) => toPipelineRecoveryReport(row as PipelineRecoveryReportRecord))
}

export function getLatestPendingPipelineRecoveryReport(
  db: Database.Database,
  input: PipelinePrdWorkSetKey
): PipelineRecoveryReport | undefined {
  const row = db
    .prepare(
      `SELECT * FROM pipeline_recovery_reports
       WHERE status = 'pending_ack'
         AND repo_id = ?
         AND provider_owner = ?
         AND provider_repo = ?
         AND prd_issue_number = ?
         AND pipeline_prd_label = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(
      input.repoId,
      input.providerOwner,
      input.providerRepo,
      input.prdIssueNumber,
      input.pipelinePrdLabel
    ) as PipelineRecoveryReportRecord | undefined
  return row ? toPipelineRecoveryReport(row) : undefined
}

export function acknowledgePipelineRecoveryReport(
  db: Database.Database,
  id: string
): PipelineRecoveryReport | undefined {
  db.prepare(
    `UPDATE pipeline_recovery_reports
     SET status = 'acknowledged',
         acknowledged_at = COALESCE(acknowledged_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     WHERE id = ?`
  ).run(id)
  return getPipelineRecoveryReport(db, id)
}

export function markPipelineRecoveryReportReplacement(
  db: Database.Database,
  reportId: string,
  replacementRunId: string
): PipelineRecoveryReport | undefined {
  db.prepare(
    `UPDATE pipeline_recovery_reports
     SET replacement_run_id = COALESCE(replacement_run_id, ?)
     WHERE id = ?`
  ).run(replacementRunId, reportId)
  return getPipelineRecoveryReport(db, reportId)
}

function reservationSelectSql(): string {
  return `SELECT r.*, runs.execution_target_type, runs.execution_target_id
          FROM pipeline_active_run_reservations r
          JOIN pipeline_runs runs ON runs.id = r.run_id`
}

function isSqliteUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}
