import { sortByUpdatedAtDescending } from '../../shared/updated-at-order'
import type { JiraIssue, JiraIssueFilter, JiraSiteSelection } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { ISSUE_LIST_FIELDS, mapJiraIssue } from './jira-issue-mapping'
import type { JiraSearchResponse } from './jira-record-pages'
import {
  shouldSurfaceSiteFailure,
  toIssueSearchFailureError,
  withJiraDeadline,
  type JiraIssueSearchFailure
} from './jira-read-failure'

const ISSUE_SEARCH_TIMEOUT_MS = 30_000

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

function sortAndLimitIssues(issues: JiraIssue[], limit: number): JiraIssue[] {
  return sortByUpdatedAtDescending(issues).slice(0, limit)
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
  return ALL_ISSUES_JQL
}

// The "all" filter is the only one without a restricting clause, and Jira Cloud's
// /rest/api/3/search/jql rejects unbounded queries with a 400. Server/DC's classic
// /search still accepts it, so the recency bound is applied per site at request time.
const ALL_ISSUES_JQL = 'resolution = Unresolved ORDER BY updated DESC'
const ALL_ISSUES_JQL_CLOUD = 'resolution = Unresolved AND updated >= -90d ORDER BY updated DESC'

function jqlForSite(entry: JiraClientForSite, jql: string, boundAll: boolean): string {
  if (boundAll && entry.site.authType !== 'server') {
    return ALL_ISSUES_JQL_CLOUD
  }
  return jql
}

async function searchIssuesForClient(
  entry: JiraClientForSite,
  jql: string,
  limit: number,
  signal?: AbortSignal
): Promise<JiraIssue[]> {
  // Server/DC only has the classic /search resource; /search/jql is Cloud-only.
  const searchPath =
    entry.site.authType === 'server'
      ? `${apiBasePath(entry.site)}/search`
      : '/rest/api/3/search/jql'
  const result = await jiraRequest<JiraSearchResponse>(entry, searchPath, {
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: limit,
      fields: ISSUE_LIST_FIELDS
    }),
    signal
  })
  return (result.issues ?? []).map((issue) => mapJiraIssue(entry.site, issue))
}

export async function listIssues(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  return searchIssues(filterToJql(filter), limit, siteId, undefined, filter === 'all')
}

export async function searchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  // Only the All filter's JQL lacks a restricting clause; caller-provided JQL
  // is never rewritten even when it happens to equal the All filter's string.
  boundAllForCloud = false
): Promise<JiraIssue[]> {
  const entries = getClients(siteId)
  if (entries.length === 0 || !jql.trim()) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const results = await withJiraDeadline(signal, ISSUE_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index) => {
        // Why: queueing on an abandoned search would keep occupying the shared Jira pool.
        await acquire(requestSignal)
        try {
          return await searchIssuesForClient(
            entry,
            jqlForSite(entry, jql.trim(), boundAllForCloud),
            safeLimit,
            requestSignal
          )
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a site failure, so don't clear tokens or mask a real one.
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            clearToken(entry.site.id)
          }
          if (surfaceSiteFailure) {
            throw toIssueSearchFailureError(error)
          }
          console.warn('[jira] searchIssues failed:', error)
          failures[index] = { error: toIssueSearchFailureError(error), auth: authFailure }
          return [] as JiraIssue[]
        } finally {
          release()
        }
      })
    )
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
