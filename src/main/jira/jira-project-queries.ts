import type { JiraProject, JiraSiteSelection } from '../../shared/jira/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapProject } from './jira-issue-mapping'
import {
  asFiniteNumber,
  fetchPagedRecords,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'
import { requireStrictJiraSite, shouldSurfaceSiteFailure } from './jira-read-failure'

function cloudProjectSearchPath(startAt: number, maxResults: number): string {
  const params = new URLSearchParams({ maxResults: String(maxResults), startAt: String(startAt) })
  return `/rest/api/3/project/search?${params.toString()}`
}

// Reads one Cloud project page; `complete` only when Jira reports no projects beyond it.
export async function readFirstCloudProjectPage(
  entry: JiraClientForSite,
  pageSize: number,
  signal: AbortSignal
): Promise<{ projects: JiraProject[]; complete: boolean }> {
  const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
    entry,
    cloudProjectSearchPath(0, pageSize),
    { signal }
  )
  if (!Array.isArray(response.values)) {
    throw new Error('Jira returned an invalid project page.')
  }
  const total = asFiniteNumber(response.total)
  const complete =
    response.isLast !== false &&
    (total === null ? response.isLast === true : response.values.length >= total)
  return { projects: response.values.map((project) => mapProject(project, entry.site)), complete }
}

export async function readProjectsForClient(
  entry: JiraClientForSite,
  signal?: AbortSignal,
  requireComplete = false
): Promise<JiraProject[]> {
  // Server/DC exposes the complete array through the classic project resource.
  const projects =
    entry.site.authType === 'server'
      ? signal
        ? await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/project`, { signal })
        : await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/project`)
      : await fetchPagedRecords(entry, 'values', cloudProjectSearchPath, 100, {
          signal,
          requireComplete
        })
  return projects.map((project) => mapProject(project, entry.site))
}

export async function listProjects(
  siteId?: JiraSiteSelection | null,
  strict = false
): Promise<JiraProject[]> {
  const entries = await getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  if (entries.length === 0) {
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return await readProjectsForClient(entry)
      } catch (error) {
        if (isAuthError(error)) {
          await clearToken(entry)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[jira] listProjects failed:', error)
        }
        if (strict) {
          throw error
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}
