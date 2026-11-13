import { formatBytes } from '../../shared/format-bytes'
import { terminalSafeLine } from '../../shared/terminal/output/terminal-safe-text'
import type {
  WorkspaceCleanupEvaluation,
  WorkspaceCleanupKeepCause,
  WorkspaceCleanupRuleReason,
  WorkspaceCleanupWaiting
} from '../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import {
  WORKSPACE_CLEANUP_UNWATCHED_CAUSES,
  type WorkspaceCleanupPreview,
  type WorkspaceCleanupReport,
  type WorkspaceCleanupRun,
  type WorkspaceCleanupRunRow,
  type WorkspaceCleanupWorkspaceRef
} from '../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  formatWorkspaceCleanupKeepCause,
  formatWorkspaceCleanupRuleReason
} from '../../shared/workspace-cleanup/workspace-cleanup-verdict-labels'

// The host reports no next run when no rule is on for any Git project it owns.
const NO_RULE_APPLIES = 'No cleanup rule is on for any project here'
export const NO_WORKSPACE_CLEANUP_RULE_ON = `${NO_RULE_APPLIES}, so nothing was removed.`

// Names and errors come from the host; strip terminal controls so a label can't rewrite the screen.
function formatTable(header: string[], unsafeRows: string[][]): string {
  const rows = unsafeRows.map((row) => row.map(terminalSafeLine))
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column].length))
  )
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
        .join('  ')
    )
    .join('\n')
}

function workspaceCells(ref: WorkspaceCleanupWorkspaceRef): string[] {
  return [ref.displayName || ref.branch || ref.path, ref.repoName]
}

function formatKeepWhy(
  cause: WorkspaceCleanupKeepCause,
  reason?: WorkspaceCleanupRuleReason,
  waiting?: WorkspaceCleanupWaiting
): string {
  const label = formatWorkspaceCleanupKeepCause(cause, waiting)
  return reason ? `${label} (${formatWorkspaceCleanupRuleReason(reason)})` : label
}

function formatWhy(evaluation: WorkspaceCleanupEvaluation): string {
  return evaluation.action === 'keep'
    ? formatKeepWhy(evaluation.cause, evaluation.reason, evaluation.waiting)
    : formatWorkspaceCleanupRuleReason(evaluation.reason)
}

function formatRunRowWhy(row: WorkspaceCleanupRunRow): string {
  const parts: string[] = []
  if (row.outcome === 'failed') {
    parts.push(row.error ?? 'failed')
  } else if (row.keepCause) {
    parts.push(formatKeepWhy(row.keepCause, row.reason, row.waiting))
  } else if (row.reason) {
    parts.push(formatWorkspaceCleanupRuleReason(row.reason))
  }
  if (row.keptOnRecheck) {
    parts.push('found on re-check')
  }
  if (row.branchKept) {
    parts.push(`branch ${row.branchKept} kept`)
  }
  return parts.join('; ')
}

export function formatWorkspaceCleanupPreview(preview: WorkspaceCleanupPreview): string {
  const watched = preview.rows.filter(
    (row) =>
      row.evaluation.action !== 'keep' ||
      !WORKSPACE_CLEANUP_UNWATCHED_CAUSES.has(row.evaluation.cause)
  )
  if (watched.length === 0) {
    return preview.rows.some(
      (row) => row.evaluation.action === 'keep' && row.evaluation.cause === 'rules-off'
    )
      ? `${NO_RULE_APPLIES}, so nothing would be removed.`
      : 'No workspace is watched by a cleanup rule.'
  }
  const removing = watched.filter((row) => row.evaluation.action !== 'keep').length
  const table = formatTable(
    ['WORKSPACE', 'PROJECT', 'ACTION', 'WHY'],
    watched.map((row) => [...workspaceCells(row), row.evaluation.action, formatWhy(row.evaluation)])
  )
  return `Would remove ${removing}, keep ${watched.length - removing}.\n\n${table}`
}

function formatRunSummary(run: WorkspaceCleanupRun): string {
  const { counts } = run
  const archived = counts.archived > 0 ? `, archived ${counts.archived}` : ''
  const freed = run.freedBytes > 0 ? ` Freed ${formatBytes(run.freedBytes)}.` : ''
  return `Removed ${counts.removed}${archived}, kept ${counts.kept}, failed ${counts.failed}.${freed}`
}

export function formatWorkspaceCleanupRun(run: WorkspaceCleanupRun): string {
  const lines = [formatRunSummary(run)]
  if (run.error) {
    lines.push(`The run stopped early: ${terminalSafeLine(run.error)}`)
  }
  if (run.rows.length > 0) {
    lines.push(
      '',
      formatTable(
        ['WORKSPACE', 'PROJECT', 'OUTCOME', 'WHY'],
        run.rows.map((row) => [...workspaceCells(row), row.outcome, formatRunRowWhy(row)])
      )
    )
  }
  return lines.join('\n')
}

export function formatWorkspaceCleanupReport(report: WorkspaceCleanupReport): string {
  const status = [
    report.nextRunAt === null
      ? `${NO_RULE_APPLIES}, so no run is scheduled.`
      : `Next run: ${new Date(report.nextRunAt).toISOString()}`
  ]
  if (report.running) {
    status.push('A run is going now.')
  }
  const [latest, ...earlier] = report.runs
  if (!latest) {
    return `${status.join(' ')}\n\nNo cleanup runs yet.`
  }
  const lines = [
    status.join(' '),
    '',
    `Last run (${terminalSafeLine(latest.trigger)}, ${new Date(latest.startedAt).toISOString()}):`,
    formatWorkspaceCleanupRun(latest)
  ]
  if (earlier.length > 0) {
    lines.push(
      '',
      'Earlier runs:',
      ...earlier.map(
        (run) =>
          `${new Date(run.startedAt).toISOString()}  ${terminalSafeLine(run.trigger)}  ${formatRunSummary(run)}${run.error ? ` ${terminalSafeLine(run.error)}` : ''}`
      )
    )
  }
  return lines.join('\n')
}
