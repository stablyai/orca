/* eslint-disable max-lines -- Why: Linear issue reads and mutations share the
   same workspace fan-out/error handling, so keeping them together avoids
   drifting auth-clearing behavior between operations. */
import type {
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearWorkspaceSelection
} from '../../shared/types'
import {
  acquire,
  release,
  getClients,
  isAuthError,
  clearToken,
  type LinearClientForWorkspace
} from './client'
import { mapLinearIssue } from './mappers'

async function mapIssueForWorkspace(
  entry: LinearClientForWorkspace,
  issue: Parameters<typeof mapLinearIssue>[0]
): Promise<LinearIssue> {
  const mapped = await mapLinearIssue(issue)
  return {
    ...mapped,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

function sortAndLimitIssues(issues: LinearIssue[], limit: number): LinearIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function shouldThrowAuthError(selection: LinearWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

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
      return await mapIssueForWorkspace(entry, issue)
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
        const result = await entry.client.searchIssues(query, { first: limit })
        return await Promise.all(result.nodes.map((issue) => mapIssueForWorkspace(entry, issue)))
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
  return sortAndLimitIssues(results.flat(), limit)
}

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed'

const ACTIVE_STATE_FILTER = { state: { type: { nin: ['completed', 'canceled'] } } }
const COMPLETED_STATE_FILTER = { state: { type: { in: ['completed', 'canceled'] } } }

export async function listIssues(
  filter: LinearListFilter = 'assigned',
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
        const orderBy = 'updatedAt' as never

        if (filter === 'assigned') {
          const viewer = await entry.client.viewer
          const connection = await viewer.assignedIssues({
            first: limit,
            orderBy,
            filter: ACTIVE_STATE_FILTER
          })
          return await Promise.all(
            connection.nodes.map((issue) => mapIssueForWorkspace(entry, issue))
          )
        }

        if (filter === 'created') {
          const viewer = await entry.client.viewer
          const connection = await viewer.createdIssues({
            first: limit,
            orderBy,
            filter: ACTIVE_STATE_FILTER
          })
          return await Promise.all(
            connection.nodes.map((issue) => mapIssueForWorkspace(entry, issue))
          )
        }

        if (filter === 'completed') {
          const viewer = await entry.client.viewer
          const connection = await viewer.assignedIssues({
            first: limit,
            orderBy,
            filter: COMPLETED_STATE_FILTER
          })
          return await Promise.all(
            connection.nodes.map((issue) => mapIssueForWorkspace(entry, issue))
          )
        }

        // 'all' — all active issues across the workspace
        const connection = await entry.client.issues({
          first: limit,
          orderBy,
          filter: ACTIVE_STATE_FILTER
        })
        return await Promise.all(
          connection.nodes.map((issue) => mapIssueForWorkspace(entry, issue))
        )
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (shouldThrowAuthError(workspaceId)) {
            throw error
          }
        } else {
          console.warn('[linear] listIssues failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return sortAndLimitIssues(results.flat(), limit)
}

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
  workspaceId?: string | null
): Promise<
  { ok: true; id: string; identifier: string; url: string } | { ok: false; error: string }
> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createIssue({
      teamId,
      title,
      ...(description ? { description } : {})
    })
    if (!result.success) {
      return { ok: false, error: 'Linear create failed' }
    }
    const issue = await result.issue
    if (!issue) {
      return { ok: false, error: 'Issue was created but could not be retrieved' }
    }
    return { ok: true, id: issue.id, identifier: issue.identifier, url: issue.url }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function updateIssue(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    // Why: labelIds is a full-replace field — a TOCTOU race exists if another
    // user changes labels between fetch and write. The caller passes the
    // complete set built from recently-fetched data. Acceptable for v1;
    // a future version could re-fetch right before writing or use webhooks.
    const resolvedLabelIds = updates.labelIds

    const payload: Record<string, unknown> = {}
    if (updates.stateId !== undefined) {
      payload.stateId = updates.stateId
    }
    if (updates.title !== undefined) {
      payload.title = updates.title
    }
    if (updates.assigneeId !== undefined) {
      payload.assigneeId = updates.assigneeId
    }
    if (updates.priority !== undefined) {
      payload.priority = updates.priority
    }
    if (resolvedLabelIds !== undefined) {
      payload.labelIds = resolvedLabelIds
    }

    const result = await entry.client.updateIssue(id, payload)
    if (!result.success) {
      return { ok: false, error: 'Linear update failed' }
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function addIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createComment({ issueId, body })
    if (!result.success) {
      return { ok: false, error: 'Failed to create comment' }
    }
    const comment = await result.comment
    return { ok: true, id: comment?.id ?? '' }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function getIssueComments(
  issueId: string,
  workspaceId?: string | null
): Promise<LinearComment[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const issue = await entry.client.issue(issueId)
    const comments = await issue.comments()
    const results: LinearComment[] = []
    for (const c of comments.nodes) {
      const user = await c.user
      results.push({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: user
          ? { displayName: user.displayName, avatarUrl: user.avatarUrl ?? undefined }
          : undefined
      })
    }
    return results
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}
