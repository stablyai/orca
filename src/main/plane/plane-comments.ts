import type { PlaneComment, PlaneMutationResult } from '../../shared/plane-types'
import { planeRequest } from './authenticated-request'
import { getClient } from './client'
import { type RawPlaneComment, userFromRaw } from './plane-issue-mappers'

export async function getIssueComments(
  workspaceSlug: string,
  projectId: string,
  issueId: string
): Promise<PlaneComment[]> {
  const client = getClient()
  if (!client) {
    return []
  }
  try {
    const raw = await planeRequest<RawPlaneComment[] | { results?: RawPlaneComment[] }>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`
    )
    const list = Array.isArray(raw) ? raw : (raw.results ?? [])
    return list.map((c) => ({
      id: c.id,
      body: c.comment_html || 'No comment text',
      author: userFromRaw(c.actor_detail),
      createdAt: c.created_at
    }))
  } catch (error) {
    console.error('[plane] failed to get comments:', error)
    return []
  }
}

export async function addIssueComment(
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  comment: string
): Promise<PlaneMutationResult> {
  const client = getClient()
  if (!client) {
    return { ok: false, error: 'Plane is not connected' }
  }
  try {
    await planeRequest(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`,
      {
        method: 'POST',
        body: {
          comment_html: `<p>${comment}</p>`
        }
      }
    )
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add comment'
    return { ok: false, error: message }
  }
}
