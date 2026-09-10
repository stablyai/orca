import {
  authorizeIssueListAccounts,
  validateIssueListContinuation
} from './mcp-issue-list-continuation'
import { finishIssueList } from './mcp-issue-list-result'
import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear/agent-access'
import { FetchResponseBodyTooLargeError } from '../../shared/fetch-response-body'
import { JsonTextStructureCapacityError } from '../../shared/json-text-structure-limit'
import { getClients, getStatus } from './client'
import { LinearAgentAccessError, linearError } from './issue-context-errors'
import { mapIssue } from './issue-context-raw'
import { encodeIssueListCursor } from './mcp-issue-list-cursor'
import { buildIssueFilter } from './mcp-issue-list-filter'
import { acquireIssueListPage } from './mcp-issue-list-acquisition'
import { IssueListAdmission } from './mcp-issue-list-admission'
import type { IssueListLifetime } from './mcp-issue-list-lifetime'
import {
  boundedListJson,
  LIST_CURSOR_BYTES,
  type IssueListRecoveryVector
} from './mcp-issue-list-recovery'

export async function readIssueListPages(
  request: LinearMcpIssueListRequest,
  state: IssueListRecoveryVector,
  owner: IssueListLifetime
): Promise<LinearMcpIssueListResult> {
  const admission = new IssueListAdmission()
  const failures: LinearMcpIssueListResult['meta']['workspaceErrors'] = []
  const failed = new Set<string>()
  const limit = request.limit === undefined ? null : Math.max(1, Math.floor(request.limit))
  const filter = buildIssueFilter(request)
  let attempts = 0
  let average = 0
  let stopReason: string | undefined
  let omittedWorkspaceErrors = 0
  while (state.workspaces.some((w) => !w.done && !failed.has(w.id))) {
    owner.signal?.throwIfAborted()
    if (limit !== null && admission.issues.length >= limit) {
      stopReason = 'row_limit'
      break
    }
    if (Date.now() >= owner.deadline || attempts >= 200) {
      stopReason = 'budget'
      break
    }
    const index = state.nextWorkspaceIndex
    const position = state.workspaces[index]
    if (position.done || failed.has(position.id)) {
      state.nextWorkspaceIndex = (index + 1) % state.workspaces.length
      continue
    }
    const remaining = limit === null ? 250 : limit - admission.issues.length
    let first = Math.min(
      250,
      remaining,
      average ? Math.max(1, Math.floor(admission.remainingBytes / average)) : 250
    )
    try {
      let committed = false
      while (!committed) {
        if (Date.now() >= owner.deadline || attempts >= 200) {
          stopReason = 'budget'
          break
        }
        attempts++
        const entry = getClients(position.id)[0]
        if (!entry || (entry.workspace.credentialRevision ?? 0) !== position.credentialRevision) {
          throw linearError(
            'linear_list_stale_recovery',
            'Linear account changed during listing; restart and reconcile.'
          )
        }
        const page = await owner
          .read(position.id, async (signal) => {
            return acquireIssueListPage(
              entry.client.options,
              {
                first,
                after: position.after,
                filter,
                orderBy: request.orderBy ?? 'updatedAt',
                includeArchived: request.includeArchived ?? false
              },
              signal
            )
          })
          .catch((error: unknown) => {
            if (
              error instanceof FetchResponseBodyTooLargeError ||
              error instanceof JsonTextStructureCapacityError
            ) {
              return null
            }
            throw error
          })
        if (!page) {
          if (first > 1) {
            first = Math.max(1, Math.floor(first / 2))
            continue
          }
          throw linearError(
            'linear_list_acquisition_too_large',
            'Linear acquisition exceeds capacity; record size is unknown.'
          )
        }
        const more = page.pageInfo.hasNextPage
        const after = page.pageInfo.endCursor ?? undefined
        if (more && page.nodes.length === 0) {
          throw linearError('linear_list_empty_page', 'Linear returned an empty nonterminal page.')
        }
        if (more && !after) {
          throw linearError(
            'linear_list_invalid_response',
            'Linear omitted a required provider cursor.'
          )
        }
        if (more && after === position.after) {
          throw linearError(
            'linear_list_cursor_cycle',
            'Linear repeated the current provider cursor.'
          )
        }
        if (after && Buffer.byteLength(after) > LIST_CURSOR_BYTES) {
          throw linearError(
            'linear_list_metadata_capacity',
            'Linear provider cursor exceeds capacity.'
          )
        }
        const rows = page.nodes.map((raw) => ({
          ...mapIssue(raw),
          workspace: { id: entry.workspace.id, name: entry.workspace.organizationName }
        }))
        const staged = admission.stage(
          rows,
          more ? JSON.stringify([position.id, after]) : undefined
        )
        if (!staged) {
          if (first > 1) {
            first = Math.max(1, Math.floor(first / 2))
            continue
          }
          if (!new IssueListAdmission().stage(rows)) {
            throw linearError(
              'linear_list_record_too_large',
              'Linear record exceeds listing capacity; details are not complete.',
              { detailsComplete: false }
            )
          }
          stopReason = 'bytes'
          break
        }
        const next = {
          ...state,
          nextWorkspaceIndex: (index + 1) % state.workspaces.length,
          workspaces: state.workspaces.map((w, i) =>
            i === index ? { ...w, after: more ? after : undefined, done: !more } : w
          )
        }
        validateIssueListContinuation(request, next, owner.expiredAccounts)
        if (more && encodeIssueListCursor(position.id, after!).length > 4096) {
          throw linearError(
            'linear_list_metadata_capacity',
            'Linear continuation exceeds capacity.'
          )
        }
        owner.signal?.throwIfAborted()
        authorizeIssueListAccounts(request, state, owner.expiredAccounts)
        staged.commit()
        if (rows.length) {
          average = staged.bytes / rows.length
        }
        Object.assign(state, next)
        committed = true
      }
      if (stopReason) {
        break
      }
    } catch (error) {
      owner.signal?.throwIfAborted()
      const failure =
        error instanceof LinearAgentAccessError
          ? error
          : linearError(
              'linear_network_error',
              'Linear listing failed; retry from the returned position.'
            )
      const item = {
        workspace: {
          id: position.id,
          name:
            getStatus().workspaces?.find((w) => w.id === position.id)?.organizationName ??
            position.id
        },
        code: failure.code,
        message: failure.message,
        data: {
          ...(failure.data &&
          typeof failure.data === 'object' &&
          'retryAfterSeconds' in failure.data &&
          typeof failure.data.retryAfterSeconds === 'number' &&
          Number.isFinite(failure.data.retryAfterSeconds) &&
          failure.data.retryAfterSeconds >= 0 &&
          failure.data.retryAfterSeconds <= 86_400
            ? { retryAfterSeconds: failure.data.retryAfterSeconds }
            : {}),
          retryPosition: {
            workspaceId: position.id,
            ...(position.after
              ? { cursor: encodeIssueListCursor(position.id, position.after) }
              : {})
          },
          detailsComplete: false,
          ...(failure.code === 'linear_list_record_too_large' ? { maxBytes: 896 * 1024 } : {})
        }
      }
      try {
        boundedListJson([...failures, item], 32 * 1024)
        failures.push(item)
      } catch {
        omittedWorkspaceErrors++
      }
      failed.add(position.id)
      state.nextWorkspaceIndex = (index + 1) % state.workspaces.length
      if (owner.cleanupPending) {
        stopReason = 'cleanup_pending'
        break
      }
      if (failure.code === 'linear_list_metadata_capacity') {
        stopReason = 'metadata_capacity'
        break
      }
    }
  }
  return finishIssueList({
    request,
    state,
    admission,
    failures,
    limit,
    stopReason,
    omittedWorkspaceErrors,
    expiredAccounts: owner.expiredAccounts
  })
}
