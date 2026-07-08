import type {
  JiraCreateField,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraSiteSelection,
  JiraTransition,
  JiraUser
} from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  isAuthError,
  jiraRequest,
  release,
  type JiraClientForSite
} from './client'
import { fetchPagedRecords } from './issue-page-fetcher'
import {
  asString,
  getCreateFieldRecords,
  mapCreateField,
  mapIssueType,
  mapPriority,
  mapProject,
  mapStatus,
  type JiraRecord
} from './issue-mappers'
import { isServerSite, restApiBase, shouldSurfaceSiteFailure } from './issue-rest-routing'
import { toJiraErrorWithStatus } from './jira-request'
import { mapJiraUser } from './jira-user-identity'

type JiraMetadataFailure = {
  error: unknown
  auth: boolean
}

async function withSingleEntryJiraList<T>(
  entry: JiraClientForSite,
  siteId: string | null | undefined,
  label: string,
  request: () => Promise<T[]>
): Promise<T[]> {
  await acquire()
  try {
    return await request()
  } catch (error) {
    const surfacedError = toJiraErrorWithStatus(error)
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw surfacedError
    }
    if (shouldSurfaceSiteFailure(siteId, 1)) {
      throw surfacedError
    }
    console.warn(`[jira] ${label} failed:`, error)
    return []
  } finally {
    release()
  }
}

export async function listProjects(siteId?: JiraSiteSelection | null): Promise<JiraProject[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const failures: (JiraMetadataFailure | undefined)[] = Array.from({ length: entries.length })
  const results = await Promise.all(
    entries.map(async (entry, index) => {
      await acquire()
      try {
        if (isServerSite(entry.site)) {
          const projects = await jiraRequest<JiraRecord[]>(entry, '/rest/api/2/project')
          return projects.map((project) => mapProject(project, entry.site))
        }
        const projects = await fetchPagedRecords(entry, 'values', (startAt, maxResults) => {
          const params = new URLSearchParams({
            maxResults: String(maxResults),
            startAt: String(startAt)
          })
          return `/rest/api/3/project/search?${params.toString()}`
        })
        return projects.map((project) => mapProject(project, entry.site))
      } catch (error) {
        const surfacedError = toJiraErrorWithStatus(error)
        const authFailure = isAuthError(error)
        if (authFailure) {
          clearToken(entry.site.id)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw surfacedError
          }
          // Why: all-sites calls should keep healthy sites visible while clearing invalid tokens.
          console.warn('[jira] listProjects auth failure (token cleared):', error)
        } else {
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw surfacedError
          }
          console.warn('[jira] listProjects failed:', error)
        }
        failures[index] = { error: surfacedError, auth: authFailure }
        return []
      } finally {
        release()
      }
    })
  )
  const recordedFailures = failures.filter(
    (failure): failure is JiraMetadataFailure => failure !== undefined
  )
  // 'all' fan-out mirrors search: partial success stays visible, but all-failed
  // metadata fetches must not look like an empty project list.
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listIssueTypes(
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  return withSingleEntryJiraList(entry, siteId, 'listIssueTypes', async () => {
    const issueTypes = await fetchPagedRecords(entry, 'issueTypes', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      return `${restApiBase(entry.site)}/issue/createmeta/${encodeURIComponent(
        projectIdOrKey
      )}/issuetypes?${params.toString()}`
    })
    return issueTypes.map(mapIssueType)
  })
}

export async function listCreateFields(
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string | null
): Promise<JiraCreateField[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  return withSingleEntryJiraList(entry, siteId, 'listCreateFields', async () => {
    const records = await fetchPagedRecords(entry, getCreateFieldRecords, (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      return `${restApiBase(entry.site)}/issue/createmeta/${encodeURIComponent(
        projectIdOrKey
      )}/issuetypes/${encodeURIComponent(issueTypeId)}?${params.toString()}`
    })
    return records
      .map((record) => mapCreateField(record))
      .filter((field): field is JiraCreateField => field !== null)
  })
}

export async function listPriorities(siteId?: string | null): Promise<JiraPriority[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  return withSingleEntryJiraList(entry, siteId, 'listPriorities', async () => {
    const response = await jiraRequest<JiraRecord[]>(entry, `${restApiBase(entry.site)}/priority`)
    return response.map(mapPriority).filter((priority): priority is JiraPriority => !!priority)
  })
}

export async function listAssignableUsers(
  key: string,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  const params = new URLSearchParams({ issueKey: key, maxResults: '50' })
  if (query?.trim()) {
    // Why: Server/DC filters assignable users by username; Cloud uses query.
    params.set(isServerSite(entry.site) ? 'username' : 'query', query.trim())
  }
  return withSingleEntryJiraList(entry, siteId, 'listAssignableUsers', async () => {
    const response = await jiraRequest<JiraRecord[]>(
      entry,
      `${restApiBase(entry.site)}/user/assignable/search?${params.toString()}`
    )
    return response
      .map((user) => mapJiraUser(user, entry.site))
      .filter((user): user is JiraUser => !!user)
  })
}

export async function listTransitions(
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  return withSingleEntryJiraList(entry, siteId, 'listTransitions', async () => {
    const response = await jiraRequest<{ transitions?: JiraRecord[] }>(
      entry,
      `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/transitions`
    )
    return (response.transitions ?? []).map((transition) => ({
      id: asString(transition.id),
      name: asString(transition.name),
      to: mapStatus(transition.to)
    }))
  })
}
