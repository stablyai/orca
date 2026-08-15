import { apiPath, getClient, planeFetch } from './client'
import {
  arrayFromResponse,
  mapComment,
  mapIssueAttachment,
  mapIssueLink,
  notNull
} from './response-mappers'
import { getIssue } from './issues'
import type { PlaneComment, PlaneIssueAttachment, PlaneIssueLink } from '../../shared/plane/types'

export async function addIssueComment(
  identifierOrId: string,
  body: string,
  instanceId?: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    const issue = await getIssue(identifierOrId, client.instance.id)
    if (!issue) {
      throw new Error('Plane work item not found')
    }
    const data = await planeFetch<Record<string, unknown>>(
      client,
      apiPath(
        client,
        `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/comments/`
      ),
      { method: 'POST', body: JSON.stringify({ comment_html: body }) }
    )
    return { ok: true, id: stringField(data, 'id') ?? '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function issueComments(
  identifierOrId: string,
  instanceId?: string
): Promise<PlaneComment[]> {
  const client = getClient(instanceId)
  const issue = await getIssue(identifierOrId, client.instance.id)
  if (!issue) {
    return []
  }
  const data = await planeFetch<unknown>(
    client,
    apiPath(
      client,
      `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/comments/`
    )
  )
  return arrayFromResponse(data).map(mapComment).filter(notNull)
}

export async function issueLinks(
  identifierOrId: string,
  instanceId?: string
): Promise<PlaneIssueLink[]> {
  const client = getClient(instanceId)
  const issue = await getIssue(identifierOrId, client.instance.id)
  if (!issue) {
    return []
  }
  const data = await planeFetch<unknown>(
    client,
    apiPath(
      client,
      `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/links/`
    )
  )
  return arrayFromResponse(data).map(mapIssueLink).filter(notNull)
}

export async function addIssueLink(
  identifierOrId: string,
  title: string,
  url: string,
  instanceId?: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    const issue = await getIssue(identifierOrId, client.instance.id)
    if (!issue) {
      throw new Error('Plane work item not found')
    }
    const data = await planeFetch<Record<string, unknown>>(
      client,
      apiPath(
        client,
        `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/links/`
      ),
      { method: 'POST', body: JSON.stringify({ title, url }) }
    )
    return { ok: true, id: stringField(data, 'id') ?? '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function issueAttachments(
  identifierOrId: string,
  instanceId?: string
): Promise<PlaneIssueAttachment[]> {
  const client = getClient(instanceId)
  const issue = await getIssue(identifierOrId, client.instance.id)
  if (!issue) {
    return []
  }
  const data = await planeFetch<unknown>(
    client,
    apiPath(
      client,
      `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/attachments/`
    )
  )
  return arrayFromResponse(data).map(mapIssueAttachment).filter(notNull)
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
