import type {
  WorkspaceCleanupEvaluation,
  WorkspaceCleanupKeepCause
} from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import {
  WORKSPACE_CLEANUP_REPORT_ROW_LIMIT,
  type WorkspaceCleanupRun,
  type WorkspaceCleanupRunOutcome,
  type WorkspaceCleanupRunRow
} from '../../../shared/workspace-cleanup/workspace-cleanup-run'

// Workspaces no rule watches are not part of a run's receipt.
const UNWATCHED_CAUSES: ReadonlySet<WorkspaceCleanupKeepCause> = new Set([
  'not-removable',
  'project-off',
  'rules-off'
])

export type WorkspaceCleanupKeptOutcome = Pick<
  WorkspaceCleanupRunRow,
  'outcome' | 'reason' | 'keepCause' | 'waiting'
>

export function keptRunOutcome(
  evaluation: WorkspaceCleanupEvaluation
): WorkspaceCleanupKeptOutcome {
  if (evaluation.action !== 'keep') {
    // Archive needs the archive backend; until then the runner only deletes.
    return { outcome: 'kept', reason: evaluation.reason, keepCause: 'archive-unavailable' }
  }
  return {
    outcome: 'kept',
    keepCause: evaluation.cause,
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    ...(evaluation.waiting ? { waiting: evaluation.waiting } : {})
  }
}

// Acted-on rows first, then protections, then time rules still counting, then plain non-matches.
function rowRank(row: WorkspaceCleanupRunRow): number {
  if (row.outcome !== 'kept') {
    return 0
  }
  if (row.keepCause === 'no-rule-matched') {
    return 3
  }
  return row.keepCause === 'waiting' ? 2 : 1
}

export function summarizeWorkspaceCleanupRun(args: {
  id: string
  trigger: WorkspaceCleanupRun['trigger']
  startedAt: number
  finishedAt: number
  rows: WorkspaceCleanupRunRow[]
  error?: string
}): WorkspaceCleanupRun {
  const rows = args.rows.filter(
    (row) => row.keepCause === undefined || !UNWATCHED_CAUSES.has(row.keepCause)
  )
  const counts: Record<WorkspaceCleanupRunOutcome, number> = {
    removed: 0,
    archived: 0,
    kept: 0,
    failed: 0
  }
  let freedBytes = 0
  for (const row of rows) {
    counts[row.outcome] += 1
    if ((row.outcome === 'removed' || row.outcome === 'archived') && row.sizeBytes) {
      freedBytes += row.sizeBytes
    }
  }
  return {
    id: args.id,
    trigger: args.trigger,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    counts,
    freedBytes,
    rows: rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => rowRank(a.row) - rowRank(b.row) || a.index - b.index)
      .slice(0, WORKSPACE_CLEANUP_REPORT_ROW_LIMIT)
      .map(({ row }) => row),
    ...(args.error ? { error: args.error } : {})
  }
}
