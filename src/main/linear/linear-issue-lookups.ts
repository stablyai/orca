import type { LinearIssue } from '../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import {
  ATTACHMENT_BY_UUID_QUERY,
  COMMENT_BY_UUID_QUERY,
  ISSUE_BY_UUID_QUERY,
  SEARCH_ISSUES_QUERY,
  type LinearAttachmentByUuidResponse,
  type LinearCommentByUuidResponse,
  type LinearIssueByUuidResponse,
  type LinearIssueConnectionResponse,
  type LinearRawVariables
} from './linear-issue-query-documents'
import {
  mapIssueForWorkspace,
  mapRawIssueForWorkspace,
  shouldThrowAuthError,
  sortAndLimitIssues
} from './linear-issue-query-support'
import {
  mapRawAttachmentWriteRecord,
  mapRawCommentWriteRecord,
  mapRawIssueWriteRecord,
  runLinearLookup,
  type LinearAttachmentWriteRecord,
  type LinearCommentWriteRecord,
  type LinearIssueWriteRecord
} from './linear-issue-write-support'

export async function getIssue(
  id: string,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue | null> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return null
  }

  for (const entry of entries) {
    await acquire()
    try {
      const issue = await entry.client.issue(id)
      return await mapIssueForWorkspace(entry, issue, {
        includeChildren: true,
        includeProject: true
      })
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
        if (shouldThrowAuthError(workspaceId)) {
          throw error
        }
      } else {
        console.warn('[linear] getIssue failed:', error)
      }
    } finally {
      release()
    }
  }
  return null
}

export async function getIssueByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearIssueWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearIssueByUuidResponse,
      LinearRawVariables
    >(ISSUE_BY_UUID_QUERY, { id })
    const issue = result.data?.issue ?? null
    return issue ? mapRawIssueWriteRecord(issue) : null
  })
}

export async function getCommentByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearCommentWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearCommentByUuidResponse,
      LinearRawVariables
    >(COMMENT_BY_UUID_QUERY, { id })
    const comment = result.data?.comment
    return comment ? mapRawCommentWriteRecord(comment) : null
  })
}

export async function getAttachmentByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearAttachmentWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearAttachmentByUuidResponse,
      LinearRawVariables
    >(ATTACHMENT_BY_UUID_QUERY, { id })
    const attachment = result.data?.attachment
    return attachment ? mapRawAttachmentWriteRecord(attachment) : null
  })
}

export async function getIssueCommentThreadRoot(
  issueId: string,
  commentId: string,
  workspaceId?: string | null
): Promise<{ id: string; parentId: string | null } | null> {
  const comment = await getCommentByUuidForAgent(commentId, workspaceId)
  if (!comment || comment.issue.id !== issueId) {
    return null
  }
  return { id: comment.threadRootId ?? comment.id, parentId: comment.parentId }
}

export async function searchIssues(
  query: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const result = await entry.client.client.rawRequest<
          LinearIssueConnectionResponse,
          LinearRawVariables
        >(SEARCH_ISSUES_QUERY, { term: query, first: limit })
        const nodes = result.data?.searchIssues?.nodes ?? []
        return nodes.map((issue) => mapRawIssueForWorkspace(entry, issue))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (shouldThrowAuthError(workspaceId)) {
            throw error
          }
        } else {
          console.warn('[linear] searchIssues failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  // Why: searchIssues returns Linear's relevance ranking. Re-sorting by
  // updatedAt would discard relevance order for single-workspace results,
  // diverging from Linear's web UI and pre-PR behavior.
  if (entries.length === 1) {
    return results.flat().slice(0, limit)
  }
  return sortAndLimitIssues(results.flat(), limit)
}
