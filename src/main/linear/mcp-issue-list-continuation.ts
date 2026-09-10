import type { LinearMcpIssueListRequest } from '../../shared/linear/mcp-issue-list'
import { getStatus } from './client'
import { linearError } from './issue-context-errors'
import { encodeIssueListCursor } from './mcp-issue-list-cursor'
import {
  boundedListJson,
  encodePageRecovery,
  type IssueListRecoveryVector
} from './mcp-issue-list-recovery'

export function concreteIssueListRecovery(state: IssueListRecoveryVector) {
  return state.workspaces.map((w) => ({
    workspaceId: w.id,
    ...(w.after ? { cursor: encodeIssueListCursor(w.id, w.after) } : {}),
    done: w.done
  }))
}

export function validateIssueListContinuation(
  request: LinearMcpIssueListRequest,
  state: IssueListRecoveryVector,
  expiredAccounts: ReadonlySet<string>
): void {
  const continuation = encodePageRecovery(state)
  if (request.pageRecovery && expiredAccounts.size === 0) {
    boundedListJson({ ...request, pageRecovery: { version: 1, continuation } })
  } else {
    const positions = concreteIssueListRecovery(state)
    boundedListJson(positions)
    for (const position of positions) {
      if (!position.done) {
        boundedListJson({
          ...request,
          pageRecovery: undefined,
          workspaceId: position.workspaceId,
          cursor: position.cursor
        })
      }
    }
  }
}

export function authorizeIssueListAccounts(
  request: LinearMcpIssueListRequest,
  state: IssueListRecoveryVector,
  expiredAccounts: ReadonlySet<string>
): void {
  const roster = getStatus().workspaces ?? []
  if (
    (request.workspaceId === 'all' &&
      roster.length !== state.workspaces.filter((w) => !expiredAccounts.has(w.id)).length) ||
    state.workspaces.some((expected) => {
      const current = roster.find((w) => w.id === expected.id)
      if (expiredAccounts.has(expected.id)) {
        return !!current
      }
      return !current || (current.credentialRevision ?? 0) !== expected.credentialRevision
    })
  ) {
    throw linearError(
      'linear_list_stale_recovery',
      'Linear accounts changed; restart concrete workspaces and reconcile.',
      {
        restartConcreteWorkspaces: true,
        detailsComplete: false
      }
    )
  }
}
