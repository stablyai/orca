import type {
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearWorkflowState,
  LinearLabel,
  LinearMember
} from '../../shared/types'
import { acquire, release, getClient, isAuthError, clearToken } from './client'
import { mapLinearIssue } from './mappers'

export async function getIssue(id: string): Promise<LinearIssue | null> {
  const client = getClient()
  if (!client) {
    return null
  }

  await acquire()
  try {
    const issue = await client.issue(id)
    return await mapLinearIssue(issue)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getIssue failed:', error)
    return null
  } finally {
    release()
  }
}

export async function searchIssues(query: string, limit = 20): Promise<LinearIssue[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const result = await client.searchIssues(query, { first: limit })
    return await Promise.all(result.nodes.map(mapLinearIssue))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] searchIssues failed:', error)
    return []
  } finally {
    release()
  }
}

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed'

const ACTIVE_STATE_FILTER = { state: { type: { nin: ['completed', 'canceled'] } } }
const COMPLETED_STATE_FILTER = { state: { type: { in: ['completed', 'canceled'] } } }

export async function listIssues(
  filter: LinearListFilter = 'assigned',
  limit = 20
): Promise<LinearIssue[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const orderBy = 'updatedAt' as never

    if (filter === 'assigned') {
      const viewer = await client.viewer
      const connection = await viewer.assignedIssues({
        first: limit,
        orderBy,
        filter: ACTIVE_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    if (filter === 'created') {
      const viewer = await client.viewer
      const connection = await viewer.createdIssues({
        first: limit,
        orderBy,
        filter: ACTIVE_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    if (filter === 'completed') {
      const viewer = await client.viewer
      const connection = await viewer.assignedIssues({
        first: limit,
        orderBy,
        filter: COMPLETED_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    // 'all' — all active issues across the workspace
    const connection = await client.issues({
      first: limit,
      orderBy,
      filter: ACTIVE_STATE_FILTER
    })
    return await Promise.all(connection.nodes.map(mapLinearIssue))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] listIssues failed:', error)
    return []
  } finally {
    release()
  }
}

export async function updateIssue(
  id: string,
  updates: LinearIssueUpdate
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getClient()
  if (!client) {
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

    const result = await client.updateIssue(id, payload)
    if (!result.success) {
      return { ok: false, error: 'Linear update failed' }
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
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
  body: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const client = getClient()
  if (!client) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await client.createComment({ issueId, body })
    if (!result.success) {
      return { ok: false, error: 'Failed to create comment' }
    }
    const comment = await result.comment
    return { ok: true, id: comment?.id ?? '' }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function getIssueComments(issueId: string): Promise<LinearComment[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const issue = await client.issue(issueId)
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
      clearToken()
      throw error
    }
    console.warn('[linear] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamStates(teamId: string): Promise<LinearWorkflowState[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
    const states = await team.states()
    return states.nodes
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        color: s.color,
        position: s.position
      }))
      .sort((a, b) => a.position - b.position)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamStates failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamLabels(teamId: string): Promise<LinearLabel[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
    const labels = await team.labels()
    return labels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamLabels failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamMembers(teamId: string): Promise<LinearMember[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
    const members = await team.members()
    return members.nodes.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl ?? undefined
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamMembers failed:', error)
    return []
  } finally {
    release()
  }
}
