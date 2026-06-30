import type {
  PipelineActiveRunReservation,
  PipelineRecoveryReport,
  PipelineRecoveryReportStatus,
  PipelineRecoveryReportSummary,
  PipelineReservationStatus
} from '../../shared/pipelines-types'

export type PipelineActiveRunReservationRecord = {
  id: string
  run_id: string
  repo_id: string
  provider_owner: string
  provider_repo: string
  pipeline_prd_label: string
  prd_issue_number: number
  status: PipelineReservationStatus
  created_at: string
  released_at: string | null
  release_reason: string | null
  last_seen_at: string
  execution_target_type: 'local' | 'ssh'
  execution_target_id: string | null
}

export type PipelineRecoveryReportRecord = {
  id: string
  interrupted_run_id: string
  replacement_run_id: string | null
  repo_id: string
  provider_owner: string
  provider_repo: string
  prd_issue_number: number
  pipeline_prd_label: string
  status: PipelineRecoveryReportStatus
  summary_json: string
  created_at: string
  acknowledged_at: string | null
}

export function toPipelineActiveRunReservation(
  row: PipelineActiveRunReservationRecord
): PipelineActiveRunReservation {
  return {
    id: row.id,
    runId: row.run_id,
    repoId: row.repo_id,
    providerOwner: row.provider_owner,
    providerRepo: row.provider_repo,
    pipelinePrdLabel: row.pipeline_prd_label,
    prdIssueNumber: row.prd_issue_number,
    status: row.status,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    lastSeenAt: row.last_seen_at,
    executionTargetType: row.execution_target_type,
    executionTargetId: row.execution_target_id
  }
}

export function toPipelineRecoveryReport(
  row: PipelineRecoveryReportRecord
): PipelineRecoveryReport {
  return {
    id: row.id,
    interruptedRunId: row.interrupted_run_id,
    replacementRunId: row.replacement_run_id,
    repoId: row.repo_id,
    providerOwner: row.provider_owner,
    providerRepo: row.provider_repo,
    pipelinePrdLabel: row.pipeline_prd_label,
    prdIssueNumber: row.prd_issue_number,
    status: row.status,
    summary: parseRecoverySummary(row.summary_json),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at
  }
}

function parseRecoverySummary(value: string): PipelineRecoveryReportSummary {
  return JSON.parse(value) as PipelineRecoveryReportSummary
}
