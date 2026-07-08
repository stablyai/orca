import type { JiraIssue, JiraIssueFilter, JiraSiteSelection } from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  isAuthError,
  jiraRequest,
  release,
  type JiraClientForSite
} from './client'
import { ISSUE_FIELDS, mapJiraIssue, type JiraRecord } from './issue-mappers'
import { isServerSite, restApiBase, shouldSurfaceSiteFailure } from './issue-rest-routing'
import { toJiraErrorWithStatus } from './jira-request'

type JiraSearchResponse = {
  issues?: JiraRecord[]
}

type JiraIssueSearchFailure = {
  error: unknown
  auth: boolean
}

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

function sortAndLimitIssues(issues: JiraIssue[], limit: number): JiraIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function filterToJql(filter: JiraIssueFilter): string {
  if (filter === 'assigned') {
    return 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'reported') {
    return 'reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'done') {
    return 'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC'
  }
  return 'resolution = Unresolved ORDER BY updated DESC'
}

async function searchIssuesForClient(
  entry: JiraClientForSite,
  jql: string,
  limit: number
): Promise<JiraIssue[]> {
  const result = await jiraRequest<JiraSearchResponse>(
    entry,
    isServerSite(entry.site) ? '/rest/api/2/search' : '/rest/api/3/search/jql',
    {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: limit,
        fields: ISSUE_FIELDS
      })
    }
  )
  return (result.issues ?? []).map((issue) => mapJiraIssue(entry.site, issue))
}

export async function listIssues(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  return searchIssues(filterToJql(filter), limit, siteId)
}

export async function searchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  const entries = getClients(siteId)
  if (entries.length === 0 || !jql.trim()) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const results = await Promise.all(
    entries.map(async (entry, index) => {
      await acquire()
      try {
        return await searchIssuesForClient(entry, jql.trim(), safeLimit)
      } catch (error) {
        const authFailure = isAuthError(error)
        if (authFailure) {
          clearToken(entry.site.id)
        }
        if (surfaceSiteFailure) {
          throw toJiraErrorWithStatus(error)
        }
        console.warn('[jira] searchIssues failed:', error)
        failures[index] = { error: toJiraErrorWithStatus(error), auth: authFailure }
        return [] as JiraIssue[]
      } finally {
        release()
      }
    })
  )
  // 'all' fan-out: only surface an error when every connected site failed, so a
  // partial success (or a genuinely empty result) is not reported as an error.
  const recordedFailures = failures.filter(
    (failure): failure is JiraIssueSearchFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return entries.length === 1
    ? results.flat().slice(0, safeLimit)
    : sortAndLimitIssues(results.flat(), safeLimit)
}

export async function getIssue(
  key: string,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue | null> {
  const entries = getClients(siteId)
  for (const entry of entries) {
    await acquire()
    try {
      const issue = await jiraRequest<JiraRecord>(
        entry,
        `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(
          ISSUE_FIELDS.join(',')
        )}`
      )
      return mapJiraIssue(entry.site, issue)
    } catch (error) {
      const surfacedError = toJiraErrorWithStatus(error)
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        if (shouldSurfaceSiteFailure(siteId, entries.length)) {
          throw surfacedError
        }
      } else {
        if (shouldSurfaceSiteFailure(siteId, entries.length)) {
          throw surfacedError
        }
        console.warn('[jira] getIssue failed:', error)
      }
    } finally {
      release()
    }
  }
  return null
}
