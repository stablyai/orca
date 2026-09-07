import type { JiraProject, JiraSiteSelection } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapProject } from './jira-issue-mapping'
import { fetchPagedRecords, type JiraRecord } from './jira-record-pages'
import { shouldSurfaceSiteFailure } from './jira-read-failure'

export async function listProjects(siteId?: JiraSiteSelection | null): Promise<JiraProject[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        // Server/DC has no /project/search resource; /project returns the
        // full list as a plain (unpaged) array.
        const projects =
          entry.site.authType === 'server'
            ? await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/project`)
            : await fetchPagedRecords(entry, 'values', (startAt, maxResults) => {
                const params = new URLSearchParams({
                  maxResults: String(maxResults),
                  startAt: String(startAt)
                })
                return `/rest/api/3/project/search?${params.toString()}`
              })
        return projects.map((project) => mapProject(project, entry.site))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[jira] listProjects failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}
