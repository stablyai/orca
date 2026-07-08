import type {
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssueUpdate,
  JiraIssueUpdateStep,
  JiraMutationResult
} from '../../shared/types'
import { acquire, clearToken, getClients, isAuthError, jiraRequest, release } from './client'
import { textToAdf } from './adf-markdown'
import { issueUrl, type JiraRecord } from './issue-mappers'
import { isServerSite, restApiBase } from './issue-rest-routing'
import { jiraAssigneePayload } from './jira-user-identity'

const JIRA_UPDATE_STEP_LABELS: Record<JiraIssueUpdateStep, string> = {
  fields: 'issue fields',
  assignee: 'assignee',
  transition: 'transition'
}

function joinJiraUpdateStepLabels(steps: JiraIssueUpdateStep[]): string {
  const labels = steps.map((step) => JIRA_UPDATE_STEP_LABELS[step])
  if (labels.length <= 1) {
    return labels[0] ?? ''
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1) ?? ''}`
}

function jiraUpdateErrorMessage(
  error: unknown,
  failedStep: JiraIssueUpdateStep,
  applied: JiraIssueUpdateStep[]
): string {
  const base = error instanceof Error ? error.message : 'Failed to update issue.'
  if (applied.length === 0) {
    return base
  }
  return `Updated ${joinJiraUpdateStepLabels(applied)}, but failed to update ${JIRA_UPDATE_STEP_LABELS[failedStep]}: ${base}`
}

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
  const applied: JiraIssueUpdateStep[] = []
  const failUpdate = (error: unknown, failedStep: JiraIssueUpdateStep): JiraMutationResult => {
    if (isAuthError(error)) {
      if (applied.length === 0) {
        throw error
      }
      clearToken(entry.site.id)
    }
    return {
      ok: false,
      error: jiraUpdateErrorMessage(error, failedStep, applied),
      applied: [...applied],
      failedStep
    }
  }
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
      try {
        await jiraRequest(entry, `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ fields })
        })
        applied.push('fields')
      } catch (error) {
        return failUpdate(error, 'fields')
      }
    }
    const hasAssigneeUpdate =
      updates.assigneeUserId !== undefined || updates.assigneeAccountId !== undefined
    const assigneeUserId =
      updates.assigneeUserId !== undefined ? updates.assigneeUserId : updates.assigneeAccountId
    if (hasAssigneeUpdate) {
      try {
        await jiraRequest(
          entry,
          `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/assignee`,
          {
            method: 'PUT',
            body: JSON.stringify(jiraAssigneePayload(entry.site, assigneeUserId))
          }
        )
        applied.push('assignee')
      } catch (error) {
        return failUpdate(error, 'assignee')
      }
    }
    if (updates.transitionId) {
      try {
        await jiraRequest(
          entry,
          `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: updates.transitionId } })
          }
        )
        applied.push('transition')
      } catch (error) {
        return failUpdate(error, 'transition')
      }
    }
    return applied.length > 0 ? { ok: true, applied } : { ok: true }
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
