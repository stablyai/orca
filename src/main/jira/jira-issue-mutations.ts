import type {
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraSite
} from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { issueUrl, toBodyText } from './jira-issue-mapping'
import type { JiraRecord } from './jira-record-pages'

/**
 * Wraps a user id in the reference object the site expects: `{accountId}` on
 * Cloud, `{name}` on Server/DC, which identifies users by username and whose
 * ids `mapUser` stores in the accountId slot.
 */
export function userFieldRef(site: JiraSite, id: string | null): JiraRecord {
  return site.authType === 'server' ? { name: id } : { accountId: id }
}

/**
 * Shapes a user-typed create value (scalar or array) into Jira's user reference
 * objects. Jira rejects a bare string here and reports the field as missing.
 */
function toUserFieldValue(site: JiraSite, value: unknown): unknown {
  if (typeof value === 'string') {
    return userFieldRef(site, value)
  }
  if (Array.isArray(value)) {
    return value.map((member) => (typeof member === 'string' ? userFieldRef(site, member) : member))
  }
  return value
}

/** Creates an issue, shaping the customFields keys named by `userFieldKeys`. */
export async function createIssue(args: JiraCreateIssueArgs): Promise<JiraCreateIssueResult> {
  const entry = getClients(args.siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }

  await acquire()
  try {
    const fields: JiraRecord = {
      project: { id: args.projectId },
      issuetype: { id: args.issueTypeId },
      summary: title
    }
    if (args.description?.trim()) {
      fields.description = toBodyText(entry.site, args.description.trim())
    }
    const userFieldKeys = new Set(args.userFieldKeys ?? [])
    for (const [fieldKey, value] of Object.entries(args.customFields ?? {})) {
      if (!fieldKey || value === undefined || value === null || value === '') {
        continue
      }
      fields[fieldKey] = userFieldKeys.has(fieldKey) ? toUserFieldValue(entry.site, value) : value
    }
    const created = await jiraRequest<{ id: string; key: string; self: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue`,
      {
        method: 'POST',
        body: JSON.stringify({ fields })
      }
    )
    return { ok: true, id: created.id, key: created.key, url: issueUrl(entry.site, created.key) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create issue.' }
  } finally {
    release()
  }
}

/** Applies field, assignee, and transition updates to an existing issue. */
export async function updateIssue(
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const fields: JiraRecord = {}
    if (updates.title !== undefined) {
      fields.summary = updates.title
    }
    if (updates.labels !== undefined) {
      fields.labels = updates.labels
    }
    if (updates.priorityId !== undefined) {
      fields.priority = updates.priorityId ? { id: updates.priorityId } : null
    }
    const issueBase = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}`
    if (Object.keys(fields).length > 0) {
      await jiraRequest(entry, issueBase, {
        method: 'PUT',
        body: JSON.stringify({ fields })
      })
    }
    if (updates.assigneeAccountId !== undefined) {
      const assigneeBody = userFieldRef(entry.site, updates.assigneeAccountId)
      await jiraRequest(entry, `${issueBase}/assignee`, {
        method: 'PUT',
        body: JSON.stringify(assigneeBody)
      })
    }
    if (updates.transitionId) {
      await jiraRequest(entry, `${issueBase}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: updates.transitionId } })
      })
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update issue.' }
  } finally {
    release()
  }
}

export async function addIssueComment(
  key: string,
  body: string,
  siteId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const comment = await jiraRequest<{ id: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ body: toBodyText(entry.site, body) })
      }
    )
    return { ok: true, id: comment.id }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}
