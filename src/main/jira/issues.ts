import type {
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssueUpdate,
  JiraMutationResult
} from '../../shared/types'
import { acquire, clearToken, getClients, isAuthError, jiraRequest, release } from './client'
import { textToAdf } from './adf-markdown'
import { issueUrl, type JiraRecord } from './issue-mappers'
import { isServerSite, restApiBase } from './issue-rest-routing'
import { jiraAssigneePayload } from './jira-user-identity'

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
      // Why: Server/DC accepts plain text fields; Cloud issue create requires ADF.
      fields.description = isServerSite(entry.site)
        ? args.description.trim()
        : textToAdf(args.description.trim())
    }
    for (const [fieldKey, value] of Object.entries(args.customFields ?? {})) {
      if (!fieldKey || value === undefined || value === null || value === '') {
        continue
      }
      fields[fieldKey] = value
    }
    const created = await jiraRequest<{ id: string; key: string; self: string }>(
      entry,
      `${restApiBase(entry.site)}/issue`,
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
    if (updates.assigneeUserId !== undefined && updates.assigneeAccountId !== undefined) {
      return { ok: false, error: 'Use only one Jira assignee identifier field.' }
    }
    if (updates.title !== undefined) {
      fields.summary = updates.title
    }
    if (updates.labels !== undefined) {
      fields.labels = updates.labels
    }
    if (updates.priorityId !== undefined) {
      fields.priority = updates.priorityId ? { id: updates.priorityId } : null
    }
    if (Object.keys(fields).length > 0) {
      await jiraRequest(entry, `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ fields })
      })
    }
    const hasAssigneeUpdate =
      updates.assigneeUserId !== undefined || updates.assigneeAccountId !== undefined
    const assigneeUserId =
      updates.assigneeUserId !== undefined ? updates.assigneeUserId : updates.assigneeAccountId
    if (hasAssigneeUpdate) {
      await jiraRequest(
        entry,
        `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/assignee`,
        {
          method: 'PUT',
          body: JSON.stringify(jiraAssigneePayload(entry.site, assigneeUserId))
        }
      )
    }
    if (updates.transitionId) {
      await jiraRequest(
        entry,
        `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/transitions`,
        {
          method: 'POST',
          body: JSON.stringify({ transition: { id: updates.transitionId } })
        }
      )
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

export { addIssueComment, getIssueComments } from './issue-comments'
export {
  listAssignableUsers,
  listCreateFields,
  listIssueTypes,
  listPriorities,
  listProjects,
  listTransitions
} from './issue-metadata'
export { getIssue, listIssues, searchIssues } from './issue-search'
export { mapJiraIssue } from './issue-mappers'
