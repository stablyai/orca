import type {
  OrchestrationCostReport,
  OrchestrationReportElapsed,
  OrchestrationReportTask
} from '../shared/orchestration-cost-report'

function formatElapsed(value: OrchestrationReportElapsed): string {
  if (value.milliseconds === null) {
    return 'unavailable'
  }
  const seconds = Math.round(value.milliseconds / 1_000)
  const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  return value.status === 'partial' ? `${text} (partial)` : text
}

function formatTask(
  task: OrchestrationReportTask,
  tasksById: Map<string, OrchestrationReportTask>,
  depth: number,
  visited: Set<string>
): string[] {
  const indent = '  '.repeat(depth)
  if (visited.has(task.id)) {
    return [`${indent}- ${task.id} [cycle]`]
  }
  visited.add(task.id)
  const lines = [
    `${indent}- ${task.id} ${task.status}; direct ${formatElapsed(task.elapsed.direct)}; rolled up ${formatElapsed(task.elapsed.rolledUp)}`
  ]
  for (const dispatch of task.dispatches) {
    const identity = dispatch.identities.worktreeId ?? 'worktree unavailable'
    lines.push(
      `${indent}  dispatch ${dispatch.id} ${dispatch.status}; ${formatElapsed(dispatch.elapsed)}; ${identity}; ${dispatch.identities.hostScope} host`
    )
  }
  for (const childId of task.childIds) {
    const child = tasksById.get(childId)
    if (child) {
      lines.push(...formatTask(child, tasksById, depth + 1, visited))
    }
  }
  return lines
}

export function formatOrchestrationCostReport(report: OrchestrationCostReport): string {
  const lines = [
    `Run ${report.run.id} (${report.completeness.status})`,
    `Elapsed: ${formatElapsed(report.totals.elapsed)}`
  ]
  if (report.totals.usage.providers.length === 0) {
    lines.push('Attributed usage: unavailable')
  } else {
    lines.push('Attributed usage (inferred; no durable terminal/session link):')
    for (const provider of report.totals.usage.providers) {
      const cost =
        provider.metrics.estimatedCostUsd === null
          ? 'cost unavailable'
          : `$${provider.metrics.estimatedCostUsd.toFixed(4)} ${provider.metrics.costStatus}`
      lines.push(
        `  ${provider.provider}: ${provider.sessionCount} session(s), ${provider.metrics.totalTokens} tokens, ${cost}`
      )
    }
  }
  lines.push('Task graph:')
  const tasksById = new Map(report.graph.tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  for (const rootId of report.graph.rootTaskIds) {
    const root = tasksById.get(rootId)
    if (root) {
      lines.push(...formatTask(root, tasksById, 0, visited))
    }
  }
  for (const task of report.graph.tasks) {
    if (!visited.has(task.id)) {
      lines.push(...formatTask(task, tasksById, 0, visited))
    }
  }
  lines.push(
    `Attribution: ${report.attribution.attributed.length} linked, ${report.attribution.unlinked.length} unlinked, ${report.attribution.ambiguous.length} ambiguous`
  )
  for (const provider of report.completeness.providerSessions) {
    if (provider.completeness !== 'complete') {
      lines.push(
        `${provider.provider} usage: ${provider.status}, ${provider.completeness}${provider.truncated ? ', truncated' : ''}`
      )
    }
  }
  for (const warning of report.completeness.warnings) {
    lines.push(`Warning: ${warning}`)
  }
  return lines.join('\n')
}
