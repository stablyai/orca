import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear/agent-access'
import { getStatus } from './client'
import { linearError } from './issue-context-errors'
import { resolveWorkspaceSelector } from './issue-context-workspaces'
import { resolveIssueListCursor } from './mcp-issue-list-cursor'
import { IssueListLifetime } from './mcp-issue-list-lifetime'
import { boundedListJson, createPageRecovery, LIST_CURSOR_BYTES } from './mcp-issue-list-recovery'
import { readIssueListPages } from './mcp-issue-list-pages'

type ListOptions = { signal?: AbortSignal; retainUntilDelivery?: (release: () => void) => void }

export async function listMcpIssues(
  request: LinearMcpIssueListRequest,
  options: ListOptions = {}
): Promise<LinearMcpIssueListResult> {
  boundedListJson(request)
  if (
    request.pageRecovery &&
    (request.workspaceId !== 'all' || request.cursor || request.pageRecovery.version !== 1)
  ) {
    throw linearError(
      'linear_invalid_workspace',
      'Page recovery requires --workspace all and cannot be combined with --cursor.'
    )
  }
  if (request.cursor && Buffer.byteLength(request.cursor) > 4096) {
    throw linearError(
      'linear_list_metadata_capacity',
      'Linear cursor exceeds capacity; restart with a concrete workspace.'
    )
  }
  const pagination = resolveIssueListCursor(request)
  if (pagination.linearCursor && Buffer.byteLength(pagination.linearCursor) > LIST_CURSOR_BYTES) {
    throw linearError('linear_list_metadata_capacity', 'Linear provider cursor exceeds capacity.')
  }
  const status = getStatus()
  const selected =
    pagination.workspaceId === 'all'
      ? (status.workspaces ?? [])
      : [
          resolveWorkspaceSelector(
            { workspaceId: pagination.workspaceId },
            status.workspaces ?? []
          ) ??
            (status.workspaces ?? []).find((w) => w.id === status.activeWorkspaceId) ??
            status.workspaces?.[0]
        ].filter((w): w is NonNullable<typeof w> => !!w)
  if (!selected.length) {
    throw linearError('linear_not_connected', 'Linear is not connected.')
  }
  const state = createPageRecovery(request, selected)
  if (!request.pageRecovery && pagination.linearCursor) {
    state.workspaces[0].after = pagination.linearCursor
  }
  const owner = new IssueListLifetime(options.signal)
  if (options.retainUntilDelivery) {
    options.retainUntilDelivery(() => owner.finish())
  }
  try {
    return await readIssueListPages(request, state, owner)
  } finally {
    if (!options.retainUntilDelivery) {
      owner.finish()
    }
  }
}
