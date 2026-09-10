import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../src/shared/maestro-run-progress'
import { legacyMaestroTaskProgress } from '../../../src/shared/maestro-run-progress'
import type { MobileMaestroRunProgress } from './mobile-maestro-run-progress'
import { buildMobileRunCompletion } from './mobile-maestro-run-completion-model'

export type MobileMaestroProgressTone = 'neutral' | 'success' | 'warning' | 'danger'

export type MobileMaestroProgressEntry = {
  key: string
  title: string
  label?: string
  detail: string
  state?: string
}

export type MobileMaestroProgressModel = {
  title: string
  outcome: string
  tone: MobileMaestroProgressTone
  progressPercent?: number
  progressLabel: string
  countsLabel: string
  reliabilityLabel: string
  reliabilityTone: MobileMaestroProgressTone
  runCompletion: MobileMaestroProgressEntry[]
  current: MobileMaestroProgressEntry[]
  completed: MobileMaestroProgressEntry[]
  blocked: MobileMaestroProgressEntry[]
  next: MobileMaestroProgressEntry[]
  nested: MobileMaestroProgressEntry[]
  warnings: MobileMaestroProgressEntry[]
  technical: Array<{ label: string; value: string }>
}

const V2_OUTCOME_LABELS: Record<MaestroRunProgressV2['execution']['state'], string> = {
  active: 'Active',
  input_required: 'Input required',
  blocked: 'Blocked',
  completed: 'Completed',
  completed_with_failures: 'Completed with failures',
  cancelled: 'Cancelled',
  outcome_unknown: 'Outcome unknown'
}

function toneForV2(state: MaestroRunProgressV2['execution']['state']): MobileMaestroProgressTone {
  if (state === 'completed') {
    return 'success'
  }
  if (state === 'blocked' || state === 'input_required' || state === 'outcome_unknown') {
    return 'warning'
  }
  if (state === 'completed_with_failures' || state === 'cancelled') {
    return 'danger'
  }
  return 'neutral'
}

function toneForLegacy(state: string): MobileMaestroProgressTone {
  if (state === 'complete') {
    return 'success'
  }
  if (state === 'blocked' || state === 'input_required' || state === 'outcome_unknown') {
    return 'warning'
  }
  if (state === 'failed') {
    return 'danger'
  }
  return 'neutral'
}

function buildV2Model(progress: MaestroRunProgressV2): MobileMaestroProgressModel {
  const execution = progress.execution
  const deliverables = progress.deliverables
  const reliability = progress.operational_reliability
  const warnings: MobileMaestroProgressEntry[] = []
  if (progress.projection_health.state !== 'healthy') {
    warnings.push({
      key: 'projection-health',
      title: 'Projection health',
      detail:
        progress.projection_health.warning ?? `Projection is ${progress.projection_health.state}.`
    })
  }
  if (progress.cleanup_health.state !== 'clean') {
    warnings.push({
      key: 'cleanup-health',
      title: 'Cleanup health',
      detail:
        progress.cleanup_health.warning ??
        `${progress.cleanup_health.count} worker resource${progress.cleanup_health.count === 1 ? '' : 's'} ${progress.cleanup_health.state}.`
    })
  }
  return {
    title: progress.run.title,
    outcome: progress.completion ? 'Completed' : V2_OUTCOME_LABELS[execution.state],
    tone: progress.completion ? 'success' : toneForV2(execution.state),
    progressPercent: deliverables?.progress_percent ?? execution.progress_percent,
    progressLabel: deliverables
      ? deliverables.progress_percent === undefined
        ? 'No deliverables'
        : `${deliverables.progress_percent}% · ${deliverables.completed}/${deliverables.total} deliverables`
      : execution.progress_percent === undefined
        ? 'No tasks'
        : `${execution.progress_percent}% · ${execution.completed}/${execution.total} tasks`,
    countsLabel: v2CountsLabel(progress),
    reliabilityLabel: reliability
      ? operationalReliabilityLabel(reliability)
      : 'Operational reliability unavailable',
    reliabilityTone:
      reliability && (reliability.failed > 0 || reliability.unverifiable > 0)
        ? 'warning'
        : 'neutral',
    runCompletion: buildMobileRunCompletion(progress.completion),
    current: progress.current.map((entry) => ({
      key: entry.reference,
      title: entry.title,
      label: entry.worker_label,
      detail: entry.activity_summary,
      state: humanize(entry.state)
    })),
    completed: progress.recently_completed.map((entry) => ({
      key: entry.reference,
      title: entry.title,
      label: entry.worker_label,
      detail: entry.outcome_summary
    })),
    blocked: progress.blocked.map((entry) => ({
      key: entry.reference,
      title: entry.title,
      label: entry.worker_label,
      detail: entry.blocker_summary
    })),
    next: progress.next.map((entry) => ({
      key: entry.reference,
      title: entry.title,
      label: entry.worker_label,
      detail: entry.next_step
    })),
    nested: progress.nested_activity.map((entry) => ({
      key: entry.child_id,
      title: entry.label,
      label: entry.model,
      detail: entry.activity_summary ?? 'Native child activity',
      state: humanize(entry.state)
    })),
    warnings,
    technical: [
      { label: 'Run ID', value: progress.technical.run_id },
      { label: 'Execution host', value: progress.technical.execution_host_id },
      { label: 'Workspace', value: progress.technical.workspace_key },
      { label: 'Revision', value: String(progress.technical.revision) }
    ]
  }
}

function v2CountsLabel(progress: MaestroRunProgressV2): string {
  const counts = progress.execution.counts
  const visible = [
    ['running', counts.running],
    ['pending', counts.pending],
    ['blocked', counts.blocked],
    ['need input', counts.input_required]
  ] as const
  const active = visible
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
  return active.join(' · ') || `${progress.execution.completed} completed`
}

function buildLegacyModel(progress: MaestroRunProgress): MobileMaestroProgressModel {
  if (!progress.available) {
    return {
      title: 'Run progress unavailable',
      outcome: 'Outcome unknown',
      tone: 'warning',
      progressLabel: 'Update or reconnect to inspect this Run',
      countsLabel: 'No current progress is available.',
      reliabilityLabel: 'Operational reliability unavailable',
      reliabilityTone: 'warning',
      runCompletion: [],
      current: [],
      completed: [],
      blocked: [],
      next: [],
      nested: [],
      warnings: [],
      technical: []
    }
  }
  const summary = progress.summary
  const taskCounts = summary.task_counts
  const taskProgress = legacyMaestroTaskProgress(summary)
  const cleanupCount = Object.values(summary.cleanup).reduce(
    (total, group) => total + group.count,
    0
  )
  const warnings = cleanupCount
    ? [
        {
          key: 'legacy-cleanup',
          title: 'Cleanup health',
          detail: `${cleanupCount} cleanup record${cleanupCount === 1 ? '' : 's'} need attention.`
        }
      ]
    : []
  return {
    title: 'Run progress',
    outcome: taskProgress.allSettled
      ? taskProgress.hasFailures
        ? 'Completed with failures'
        : 'Completed'
      : humanize(summary.state),
    tone: taskProgress.allSettled
      ? taskProgress.hasFailures
        ? 'danger'
        : 'success'
      : toneForLegacy(summary.state),
    progressPercent: taskProgress.percent,
    progressLabel:
      taskProgress.percent === undefined
        ? 'No tasks'
        : `${taskProgress.percent}% · ${taskProgress.completed}/${taskProgress.total} tasks`,
    countsLabel: legacyCountsLabel(taskCounts),
    reliabilityLabel: 'Operational reliability requires a newer Orca host',
    reliabilityTone: 'warning',
    runCompletion: [],
    current: summary.current_tasks.map((entry, index) => ({
      key: `current-${index}`,
      title: 'Active task',
      detail: 'Human task details require a newer Orca host.',
      state: humanize(entry.status)
    })),
    completed: [],
    blocked: summary.blockers.slice(0, taskCounts.blocked).map((_, index) => ({
      key: `blocked-${index}`,
      title: 'Blocked task',
      detail: 'Blocker details require a newer Orca host.'
    })),
    next: summary.next_tasks.map((_, index) => ({
      key: `next-${index}`,
      title: 'Queued task',
      detail: 'Ready after the active work settles.'
    })),
    nested: [],
    warnings,
    technical: [
      { label: 'Run ID', value: progress.authority.runId },
      { label: 'Execution host', value: progress.authority.workspace.executionHostId },
      { label: 'Workspace', value: progress.authority.workspace.workspaceKey },
      { label: 'Revision', value: String(progress.authority.revision) }
    ]
  }
}

function operationalReliabilityLabel(
  reliability: NonNullable<MaestroRunProgressV2['operational_reliability']>
): string {
  const labels = [
    ['successful', reliability.successful],
    ['failed', reliability.failed],
    ['superseded', reliability.superseded],
    ['unverifiable', reliability.unverifiable]
  ] as const
  return (
    labels
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${count} ${label}`)
      .join(' · ') || 'No operational attempts'
  )
}

function legacyCountsLabel(counts: {
  approved: number
  running: number
  input_required: number
  blocked: number
  pending: number
  failed: number
}): string {
  const visible = [
    ['approved', counts.approved],
    ['running', counts.running],
    ['pending', counts.pending],
    ['blocked', counts.blocked],
    ['need input', counts.input_required],
    ['failed', counts.failed]
  ] as const
  const labels = visible
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
  return labels.join(' · ') || 'No tasks'
}

function humanize(value: string): string {
  const label = value.replaceAll('_', ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

export function buildMobileMaestroProgressModel(
  payload: MobileMaestroRunProgress
): MobileMaestroProgressModel {
  return payload.schemaVersion === 2
    ? buildV2Model(payload.progress)
    : buildLegacyModel(payload.progress)
}
