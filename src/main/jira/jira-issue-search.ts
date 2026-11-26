import { sortByUpdatedAtDescending } from '../../shared/collections/updated-at-order'
import type {
  JiraIssue,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraProject,
  JiraSiteSelection
} from '../../shared/jira/jira-types'
import { buildJiraPresetJql, searchJiraPreset } from '../../shared/jira/jira-preset-jql'
import { restrictJiraQueryToProjectIds } from '../../shared/jira/jira-project-reference'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { JiraApiError } from './jira-api-error'
import { ISSUE_LIST_FIELDS, mapJiraIssue, type JiraAgileFieldIds } from './jira-issue-mapping'
import { agileFieldIdList, getAgileFieldIds } from './jira-agile-fields'
import type { JiraSearchResponse } from './jira-record-pages'
import { readFirstCloudProjectPage, readProjectsForClient } from './jira-project-queries'
import {
  requireStrictJiraSite,
  shouldSurfaceSiteFailure,
  toIssueSearchFailureError,
  withJiraDeadline,
  type JiraIssueSearchFailure
} from './jira-read-failure'

const ISSUE_SEARCH_TIMEOUT_MS = 30_000
const PROJECTS_PER_QUERY = 100
const BOUNDED_RETRY_SKIP_MS = 5 * 60_000
// Site id -> when to stop skipping the unbounded-JQL retry; set when its projects did not fit one query.
const sitesSkippingBoundedRetry = new Map<string, number>()
type JiraIssueQuery = { filter: JiraIssueFilter; filters?: JiraIssueListFilters } | { jql: string }

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

function sortAndLimitIssues(issues: JiraIssue[], limit: number): JiraIssue[] {
  return sortByUpdatedAtDescending(issues).slice(0, limit)
}

async function readIssuesForClient(
  entry: JiraClientForSite,
  query: JiraIssueQuery,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  if ('jql' in query) {
    try {
      return await searchIssuesForClient(entry, query.jql, limit, agileFields, signal)
    } catch (error) {
      if (entry.site.authType === 'server' || !isUnboundedJqlError(error)) {
        throw error
      }
      // Any retry failure keeps Jira's 400 so the renderer's text fallback still runs.
      const issues = await searchBoundedToVisibleProjects(
        entry,
        query.jql,
        limit,
        agileFields,
        signal
      ).catch(() => null)
      if (!issues) {
        throw error
      }
      return issues
    }
  }
  if (entry.site.authType === 'server') {
    return searchJiraPreset(query.filter, query.filters, (jql) =>
      searchIssuesForClient(entry, jql, limit, agileFields, signal)
    )
  }
  const jql = buildJiraPresetJql(query.filter, query.filters)
  if (query.filter !== 'all') {
    return searchIssuesForClient(entry, jql, limit, agileFields, signal)
  }
  const projectIds = uniqueProjectIds(await readProjectsForClient(entry, signal, true))
  const issues: JiraIssue[] = []
  // Cloud requires a search restriction; project bounds preserve older open work.
  for (let start = 0; start < projectIds.length; start += PROJECTS_PER_QUERY) {
    const ids = projectIds.slice(start, start + PROJECTS_PER_QUERY).map((id) => JSON.stringify(id))
    issues.push(
      ...(await searchIssuesForClient(
        entry,
        `project in (${ids.join(', ')}) AND ${jql}`,
        limit,
        agileFields,
        signal,
        true
      ))
    )
  }
  return sortAndLimitIssues(issues, limit)
}

function isUnboundedJqlError(error: unknown): boolean {
  return (
    error instanceof JiraApiError && error.status === 400 && /unbounded jql/i.test(error.message)
  )
}

function uniqueProjectIds(projects: JiraProject[]): string[] {
  const projectIds = [...new Set(projects.map((project) => project.id || project.key))]
  if (projectIds.some((id) => !id)) {
    throw new Error('Jira returned a project without an ID or key.')
  }
  return projectIds
}

// Merging per-chunk results would replace the caller's ORDER BY with recency, so retry only when
// one project page lists every visible project and they fit one bounded query.
async function searchBoundedToVisibleProjects(
  entry: JiraClientForSite,
  jql: string,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal
): Promise<JiraIssue[] | null> {
  if ((sitesSkippingBoundedRetry.get(entry.site.id) ?? 0) > Date.now()) {
    return null
  }
  const page = await readFirstCloudProjectPage(entry, PROJECTS_PER_QUERY, signal)
  if (!page.complete) {
    sitesSkippingBoundedRetry.set(entry.site.id, Date.now() + BOUNDED_RETRY_SKIP_MS)
    return null
  }
  const projectIds = uniqueProjectIds(page.projects)
  if (projectIds.length === 0) {
    return null
  }
  const boundedJql = restrictJiraQueryToProjectIds(jql, projectIds)
  return searchIssuesForClient(entry, boundedJql, limit, agileFields, signal, true)
}

async function searchIssuesForClient(
  entry: JiraClientForSite,
  jql: string,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal?: AbortSignal,
  collectPages = false
): Promise<JiraIssue[]> {
  // Server/DC only has the classic /search resource; /search/jql is Cloud-only.
  const searchPath =
    entry.site.authType === 'server'
      ? `${apiBasePath(entry.site)}/search`
      : '/rest/api/3/search/jql'
  const issues: JiraIssue[] = []
  const seenTokens = new Set<string>()
  let nextPageToken: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = await jiraRequest<JiraSearchResponse>(entry, searchPath, {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: limit - issues.length,
        fields: [...ISSUE_LIST_FIELDS, ...agileFieldIdList(agileFields)],
        ...(nextPageToken ? { nextPageToken } : {})
      }),
      signal
    })
    if (collectPages && !Array.isArray(result.issues)) {
      throw new Error('Jira returned an invalid issue page.')
    }
    issues.push(
      ...(result.issues ?? []).map((issue) =>
        mapJiraIssue(entry.site, issue, undefined, agileFields)
      )
    )
    if (!collectPages || issues.length >= limit || result.isLast === true) {
      return issues.slice(0, limit)
    }
    if (!result.nextPageToken) {
      if (result.isLast === false) {
        throw new Error('Jira returned an incomplete issue page.')
      }
      return issues.slice(0, limit)
    }
    if (typeof result.nextPageToken !== 'string' || seenTokens.has(result.nextPageToken)) {
      throw new Error('Jira returned an invalid or repeated issue page token.')
    }
    nextPageToken = result.nextPageToken
    seenTokens.add(nextPageToken)
  }
  throw new Error('Jira issue search exceeded the page limit. Select a project with JQL instead.')
}

export async function listIssues(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null,
  strict = false,
  filters?: JiraIssueListFilters
): Promise<JiraIssue[]> {
  return runIssueSearch({ filter, filters }, limit, siteId, undefined, strict)
}

export async function searchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false
): Promise<JiraIssue[]> {
  return runIssueSearch({ jql: jql.trim() }, limit, siteId, signal, strict)
}

async function runIssueSearch(
  query: JiraIssueQuery,
  limit: number,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false
): Promise<JiraIssue[]> {
  const entries = await getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  if (entries.length === 0 || ('jql' in query && !query.jql)) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const results = await withJiraDeadline(signal, ISSUE_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index) => {
        // Discovery owns a slot, so finish it before acquiring the search slot.
        const agileFields = await getAgileFieldIds(entry, requestSignal)
        // Pass cancellation through queue admission so abandoned searches do not occupy the shared pool.
        await acquire(requestSignal)
        try {
          return await readIssuesForClient(entry, query, safeLimit, agileFields, requestSignal)
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a site failure, so don't clear tokens or mask a real one.
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            await clearToken(entry)
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
  // Preserve partial success, including empty results; report failure only when every connected site fails.
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
