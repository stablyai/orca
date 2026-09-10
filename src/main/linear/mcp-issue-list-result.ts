import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear/mcp-issue-list'
import type { IssueListAdmission } from './mcp-issue-list-admission'
import {
  authorizeIssueListAccounts,
  concreteIssueListRecovery,
  validateIssueListContinuation
} from './mcp-issue-list-continuation'
import { linearError } from './issue-context-errors'
import { encodeIssueListCursor } from './mcp-issue-list-cursor'
import { encodePageRecovery, type IssueListRecoveryVector } from './mcp-issue-list-recovery'

export function finishIssueList({
  request,
  state,
  admission,
  failures,
  limit,
  stopReason,
  omittedWorkspaceErrors,
  expiredAccounts
}: {
  request: LinearMcpIssueListRequest
  state: IssueListRecoveryVector
  admission: IssueListAdmission
  failures: LinearMcpIssueListResult['meta']['workspaceErrors']
  limit: number | null
  stopReason?: string
  omittedWorkspaceErrors: number
  expiredAccounts: ReadonlySet<string>
}): LinearMcpIssueListResult {
  authorizeIssueListAccounts(request, state, expiredAccounts)
  const hasMore = state.workspaces.some((w) => !w.done)
  try {
    validateIssueListContinuation(request, state, expiredAccounts)
  } catch {
    throw linearError(
      'linear_list_metadata_capacity',
      'Linear continuation cannot fit the unchanged query; restart concrete workspaces and reconcile.',
      {
        ...(expiredAccounts.size ? {} : { pageRecovery: request.pageRecovery }),
        restartConcreteWorkspaces: true,
        detailsComplete: false
      }
    )
  }
  const concreteRecovery = expiredAccounts.size ? concreteIssueListRecovery(state) : undefined
  const pageRecovery =
    request.pageRecovery && !concreteRecovery
      ? {
          version: 1 as const,
          continuation: encodePageRecovery(state),
          ordering: 'admitted_batch' as const,
          consistency: 'best_effort' as const,
          ...(stopReason ? { stopReason } : {})
        }
      : undefined
  if (request.workspaceId === 'all' && hasMore && !request.pageRecovery) {
    throw linearError(
      'linear_list_concrete_workspace_required',
      'Incomplete all-workspace listing requires concrete workspace restart and reconciliation.',
      {
        restartConcreteWorkspaces: true,
        partial: failures.length + omittedWorkspaceErrors > 0,
        workspaceErrors: failures.map(({ workspace, code, message }) => ({
          workspace,
          code,
          message
        })),
        omittedWorkspaceErrors,
        nextSteps: [
          'Run linear status --json to identify connected workspaces, then restart the original query for each concrete workspace.'
        ]
      }
    )
  }
  if (admission.issues.length === 0 && hasMore) {
    const failure = failures[0]
    throw linearError(
      failure?.code ?? 'linear_timeout',
      failure?.message ?? 'Linear listing stopped before a page was admitted.',
      {
        ...(failure?.data && typeof failure.data === 'object' ? failure.data : {}),
        ...(concreteRecovery ? { concreteRecovery, restartConcreteWorkspaces: true } : {}),
        ...(pageRecovery
          ? { pageRecovery }
          : {
              retryPosition: {
                workspaceId: state.workspaces[0].id,
                ...(state.workspaces[0].after
                  ? {
                      cursor: encodeIssueListCursor(
                        state.workspaces[0].id,
                        state.workspaces[0].after
                      )
                    }
                  : {})
              }
            }),
        detailsComplete: false,
        nextSteps: [
          'Use --json to inspect the recovery position; retry or restart and reconcile by workspace and issue ID.'
        ]
      }
    )
  }
  admission.issues.sort((a, b) =>
    (b[request.orderBy ?? 'updatedAt'] ?? '').localeCompare(a[request.orderBy ?? 'updatedAt'] ?? '')
  )
  const concrete = request.workspaceId !== 'all' ? state.workspaces[0] : undefined
  return {
    issues: admission.issues,
    truncated: hasMore,
    meta: {
      limit,
      returned: admission.issues.length,
      hasMore,
      ...(concrete && hasMore && concrete.after
        ? { nextCursor: encodeIssueListCursor(concrete.id, concrete.after) }
        : {}),
      ...(pageRecovery ? { pageRecovery } : {}),
      ...(concreteRecovery ? { concreteRecovery } : {}),
      orderBy: request.orderBy ?? 'updatedAt',
      workspaceId: concrete?.id ?? 'all',
      partial: failures.length + omittedWorkspaceErrors > 0,
      workspaceErrors: failures,
      ...(omittedWorkspaceErrors ? { omittedWorkspaceErrors } : {})
    }
  }
}
