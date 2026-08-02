import type {
  OrchestrationCostReport,
  OrchestrationReportUsageSession,
  OrchestrationReportUsageSnapshot,
  OrchestrationReportWorktreeHostScope
} from '../../../shared/orchestration-cost-report'
import type { OrchestrationReportDispatchRow } from './db'
import type { ReportInterval } from './cost-report-aggregation'

export function isRemoteReportDispatch(dispatch: OrchestrationReportDispatchRow): boolean {
  return Boolean(
    dispatch.environment_id || dispatch.remote_worktree_id || dispatch.remote_terminal_handle
  )
}

export function reportDispatchHostScope(
  dispatch: OrchestrationReportDispatchRow,
  worktreeHostScopes: Map<string, OrchestrationReportWorktreeHostScope>
): OrchestrationReportWorktreeHostScope {
  if (isRemoteReportDispatch(dispatch)) {
    return 'remote'
  }
  return dispatch.worktree_id
    ? (worktreeHostScopes.get(dispatch.worktree_id) ?? 'unknown')
    : 'unknown'
}

function matchesSession(
  dispatch: OrchestrationReportDispatchRow,
  session: OrchestrationReportUsageSession,
  interval: ReportInterval,
  first: number,
  last: number,
  contained: boolean
): boolean {
  const worktreeId = isRemoteReportDispatch(dispatch)
    ? (dispatch.remote_worktree_id ?? dispatch.worktree_id)
    : dispatch.worktree_id
  return (
    worktreeId === session.worktreeId &&
    (contained
      ? first >= interval.start && last <= interval.end
      : first <= interval.end && last >= interval.start)
  )
}

export function attributeReportUsage(input: {
  dispatches: OrchestrationReportDispatchRow[]
  intervalsByDispatch: Map<string, ReportInterval>
  usageSnapshots: OrchestrationReportUsageSnapshot[]
  worktreeHostScopes: Map<string, OrchestrationReportWorktreeHostScope>
}): {
  attributed: OrchestrationCostReport['attribution']['attributed']
  unlinked: OrchestrationCostReport['attribution']['unlinked']
  ambiguous: OrchestrationCostReport['attribution']['ambiguous']
  sessionsByTask: Map<string, OrchestrationReportUsageSession[]>
} {
  const attributed: OrchestrationCostReport['attribution']['attributed'] = []
  const unlinked: OrchestrationCostReport['attribution']['unlinked'] = []
  const ambiguous: OrchestrationCostReport['attribution']['ambiguous'] = []
  const sessionsByTask = new Map<string, OrchestrationReportUsageSession[]>()
  for (const session of input.usageSnapshots.flatMap((snapshot) => snapshot.sessions)) {
    const first = Date.parse(session.firstTimestamp)
    const last = Date.parse(session.lastTimestamp)
    if (
      session.locationStatus !== 'exact' ||
      !session.worktreeId ||
      !Number.isFinite(first) ||
      !Number.isFinite(last) ||
      last < first
    ) {
      unlinked.push({
        provider: session.provider,
        sessionId: session.sessionId,
        reason:
          session.locationStatus === 'mixed'
            ? 'mixed_worktree_session'
            : session.locationStatus !== 'exact' || !session.worktreeId
              ? 'worktree_unavailable'
              : 'malformed_session_timestamps'
      })
      continue
    }
    const contained = input.dispatches.filter((dispatch) => {
      const interval = input.intervalsByDispatch.get(dispatch.id)
      return Boolean(interval && matchesSession(dispatch, session, interval, first, last, true))
    })
    const containedScopes = contained.map((dispatch) =>
      reportDispatchHostScope(dispatch, input.worktreeHostScopes)
    )
    const eligible = contained.filter(
      (dispatch) => reportDispatchHostScope(dispatch, input.worktreeHostScopes) === 'local'
    )
    const overlapsKnownInterval = input.dispatches.some((dispatch) => {
      const interval = input.intervalsByDispatch.get(dispatch.id)
      return Boolean(interval && matchesSession(dispatch, session, interval, first, last, false))
    })
    if (eligible.length === 0) {
      unlinked.push({
        provider: session.provider,
        sessionId: session.sessionId,
        reason: containedScopes.includes('remote')
          ? 'remote_dispatch_usage_unavailable'
          : containedScopes.includes('unknown')
            ? 'dispatch_host_scope_unknown'
            : overlapsKnownInterval
              ? 'session_not_contained_in_dispatch_interval'
              : 'no_eligible_dispatch'
      })
    } else if (eligible.length > 1) {
      ambiguous.push({
        provider: session.provider,
        sessionId: session.sessionId,
        eligibleDispatchIds: eligible.map((dispatch) => dispatch.id).sort()
      })
    } else {
      const dispatch = eligible[0]
      attributed.push({
        provider: session.provider,
        sessionId: session.sessionId,
        dispatchId: dispatch.id,
        certainty: 'inferred'
      })
      const sessions = sessionsByTask.get(dispatch.task_id) ?? []
      sessions.push(session)
      sessionsByTask.set(dispatch.task_id, sessions)
    }
  }
  return { attributed, unlinked, ambiguous, sessionsByTask }
}
