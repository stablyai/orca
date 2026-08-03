import {
  ORCHESTRATION_REPORT_DISPATCH_LIMIT,
  ORCHESTRATION_REPORT_SESSION_LIMIT,
  ORCHESTRATION_REPORT_TASK_LIMIT,
  type OrchestrationCostReport,
  type OrchestrationReportTask,
  type OrchestrationReportUsageSnapshot,
  type OrchestrationReportWorktreeHost
} from '../../../shared/orchestration-cost-report'
import type { OrchestrationReportRecords } from './db'
import {
  aggregateElapsed,
  aggregateUsage,
  collectDescendants,
  parseReportInterval,
  recordedWorkdir,
  REPORT_PROVIDERS,
  type ReportInterval
} from './cost-report-aggregation'
import { attributeReportUsage, reportDispatchHostScope } from './cost-report-attribution'

export function buildOrchestrationCostReport(input: {
  records: OrchestrationReportRecords
  usageSnapshots: OrchestrationReportUsageSnapshot[]
  worktreeHosts: OrchestrationReportWorktreeHost[]
  generatedAt: string
}): OrchestrationCostReport {
  const asOfMs = Date.parse(input.generatedAt)
  if (!Number.isFinite(asOfMs)) {
    throw new Error('Report generatedAt must be a valid ISO timestamp.')
  }
  const warnings = new Set<string>()
  const tasksById = new Map(input.records.tasks.map((task) => [task.id, task]))
  const childrenByTask = new Map<string, string[]>()
  for (const task of input.records.tasks) {
    if (task.parent_id && tasksById.has(task.parent_id)) {
      const children = childrenByTask.get(task.parent_id) ?? []
      children.push(task.id)
      childrenByTask.set(task.parent_id, children)
    } else if (task.parent_id) {
      warnings.add(`Task ${task.id} has an unavailable parent ${task.parent_id}.`)
    }
  }
  for (const children of childrenByTask.values()) {
    children.sort()
  }

  const dispatchRows = input.records.dispatches.filter((row) => tasksById.has(row.task_id))
  const worktreeHostScopes = new Map(input.worktreeHosts.map((row) => [row.worktreeId, row.scope]))
  const dispatchHostScopes = new Map(
    dispatchRows.map((row) => [row.id, reportDispatchHostScope(row, worktreeHostScopes)])
  )
  const remoteDispatchRows = dispatchRows.filter(
    (row) => dispatchHostScopes.get(row.id) === 'remote'
  )
  const unknownHostDispatchRows = dispatchRows.filter(
    (row) => dispatchHostScopes.get(row.id) === 'unknown'
  )
  const intervalsByDispatch = new Map<string, ReportInterval>()
  const malformedDispatches = new Set<string>()
  for (const dispatch of dispatchRows) {
    const interval = parseReportInterval(dispatch, asOfMs)
    if (interval) {
      intervalsByDispatch.set(dispatch.id, interval)
    } else {
      malformedDispatches.add(dispatch.id)
      warnings.add(`Dispatch ${dispatch.id} has malformed or reversed timestamps.`)
    }
  }

  const { attributed, unlinked, ambiguous, sessionsByTask } = attributeReportUsage({
    dispatches: dispatchRows,
    intervalsByDispatch,
    usageSnapshots: input.usageSnapshots,
    worktreeHostScopes
  })

  const taskReports: OrchestrationReportTask[] = input.records.tasks.map((task) => {
    const taskDispatches = dispatchRows.filter((dispatch) => dispatch.task_id === task.id)
    const taskIntervals = taskDispatches.flatMap((dispatch) => {
      const interval = intervalsByDispatch.get(dispatch.id)
      return interval ? [interval] : []
    })
    const rolledTaskIds = new Set([
      task.id,
      ...collectDescendants(task.id, childrenByTask, warnings)
    ])
    const rolledDispatches = dispatchRows.filter((dispatch) => rolledTaskIds.has(dispatch.task_id))
    const rolledIntervals = rolledDispatches.flatMap((dispatch) => {
      const interval = intervalsByDispatch.get(dispatch.id)
      return interval ? [interval] : []
    })
    const directSessions = sessionsByTask.get(task.id) ?? []
    const rolledSessions = [...rolledTaskIds].flatMap((id) => sessionsByTask.get(id) ?? [])
    return {
      id: task.id,
      parentId: task.parent_id,
      childIds: childrenByTask.get(task.id) ?? [],
      status: task.status,
      createdAt: task.created_at,
      completedAt: task.completed_at,
      dispatches: taskDispatches.map((dispatch) => {
        const worktreeId = dispatch.remote_worktree_id ?? dispatch.worktree_id
        return {
          id: dispatch.id,
          taskId: dispatch.task_id,
          status: dispatch.status,
          workerState: dispatch.worker_state,
          createdAt: dispatch.created_at,
          dispatchedAt: dispatch.dispatched_at,
          completedAt: dispatch.completed_at,
          elapsed: aggregateElapsed(
            intervalsByDispatch.has(dispatch.id)
              ? [intervalsByDispatch.get(dispatch.id) as ReportInterval]
              : [],
            malformedDispatches.has(dispatch.id)
          ),
          identities: {
            assigneeTerminalHandle: dispatch.assignee_handle,
            agentTerminalHandle: dispatch.remote_terminal_handle ?? dispatch.agent_terminal_handle,
            terminalSessionId: null,
            terminalSessionIdStatus: 'unavailable',
            worktreeId,
            hostScope: dispatchHostScopes.get(dispatch.id) ?? 'unknown',
            workdir: recordedWorkdir(worktreeId),
            workdirStatus: recordedWorkdir(worktreeId) ? 'recorded' : 'unavailable',
            environmentId: dispatch.environment_id,
            environmentName: dispatch.environment_name
          }
        }
      }),
      elapsed: {
        direct: aggregateElapsed(
          taskIntervals,
          taskDispatches.some((row) => malformedDispatches.has(row.id))
        ),
        rolledUp: aggregateElapsed(
          rolledIntervals,
          rolledDispatches.some((row) => malformedDispatches.has(row.id))
        )
      },
      usage: {
        direct: aggregateUsage(directSessions),
        rolledUp: aggregateUsage(rolledSessions)
      }
    }
  })

  const rootTaskIds = input.records.tasks
    .filter((task) => !task.parent_id || !tasksById.has(task.parent_id))
    .map((task) => task.id)
    .sort()
  const allIntervals = [...intervalsByDispatch.values()]
  const completenessProviders = REPORT_PROVIDERS.map((provider) => {
    const snapshot = input.usageSnapshots.find((candidate) => candidate.provider === provider)
    const status = snapshot?.status ?? ('error' as const)
    const limitations = snapshot?.limitations ?? []
    return {
      provider,
      scope: 'runtime_host_local_only' as const,
      completeness:
        status !== 'available'
          ? ('unavailable' as const)
          : snapshot?.truncated ||
              limitations.length > 0 ||
              remoteDispatchRows.length > 0 ||
              unknownHostDispatchRows.length > 0
            ? ('partial' as const)
            : ('complete' as const),
      included: snapshot?.sessions.length ?? 0,
      limit: ORCHESTRATION_REPORT_SESSION_LIMIT,
      truncated: snapshot?.truncated ?? false,
      status,
      lastScanCompletedAt: snapshot?.lastScanCompletedAt ?? null,
      message: snapshot?.message ?? 'Provider usage snapshot is unavailable.',
      limitations
    }
  })
  for (const provider of completenessProviders) {
    if (provider.status !== 'available' && provider.message) {
      warnings.add(`${provider.provider} usage unavailable: ${provider.message}`)
    }
    if (provider.truncated) {
      warnings.add(`${provider.provider} usage sessions were truncated at the report limit.`)
    }
    for (const limitation of provider.limitations) {
      warnings.add(`${provider.provider} usage limitation: ${limitation}`)
    }
  }
  if (remoteDispatchRows.length > 0) {
    warnings.add(
      `${remoteDispatchRows.length} remote Dispatch(es) were excluded from host-local usage attribution.`
    )
  }
  if (unknownHostDispatchRows.length > 0) {
    warnings.add(
      `${unknownHostDispatchRows.length} Dispatch host scope(s) could not be resolved; usage attribution was excluded.`
    )
  }
  const partial =
    input.records.taskCount > input.records.tasks.length ||
    input.records.dispatchCount > input.records.dispatches.length ||
    malformedDispatches.size > 0 ||
    remoteDispatchRows.length > 0 ||
    unknownHostDispatchRows.length > 0 ||
    completenessProviders.some(
      (provider) =>
        provider.status !== 'available' || provider.truncated || provider.limitations.length > 0
    )

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    run: {
      id: input.records.run.id,
      createdAt: input.records.run.created_at,
      updatedAt: input.records.run.updated_at
    },
    graph: { rootTaskIds, tasks: taskReports },
    totals: {
      elapsed: aggregateElapsed(allIntervals, malformedDispatches.size > 0),
      usage: aggregateUsage([...sessionsByTask.values()].flat())
    },
    attribution: {
      rule: 'exact_worktree_and_contained_dispatch_interval_unique_within_run',
      certainty: 'inferred_no_durable_terminal_provider_session_link',
      attributed: attributed.sort((a, b) =>
        `${a.provider}:${a.sessionId}`.localeCompare(`${b.provider}:${b.sessionId}`)
      ),
      unlinked: unlinked.sort((a, b) =>
        `${a.provider}:${a.sessionId}`.localeCompare(`${b.provider}:${b.sessionId}`)
      ),
      ambiguous: ambiguous.sort((a, b) =>
        `${a.provider}:${a.sessionId}`.localeCompare(`${b.provider}:${b.sessionId}`)
      )
    },
    provenance: {
      orchestration: 'live_runtime_database_structured_rows',
      usage: 'live_runtime_in_memory_usage_snapshots',
      usageHostScope: 'runtime_host_local_only',
      attribution: 'inferred_no_durable_terminal_provider_session_link',
      excluded: [
        'message bodies and payloads',
        'task specs and results',
        'worker start options and errors',
        'environment variables',
        'raw transcripts'
      ]
    },
    completeness: {
      status: partial ? 'partial' : 'complete',
      taskRows: {
        included: input.records.tasks.length,
        available: input.records.taskCount,
        limit: ORCHESTRATION_REPORT_TASK_LIMIT
      },
      dispatchRows: {
        included: input.records.dispatches.length,
        available: input.records.dispatchCount,
        limit: ORCHESTRATION_REPORT_DISPATCH_LIMIT
      },
      providerSessions: completenessProviders,
      warnings: [...warnings].sort()
    }
  }
}
