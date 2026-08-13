import type { JiraSavedFilter, JiraSite, JiraSiteSelection } from '../../shared/types'
import {
  acquire,
  apiBasePath,
  clearToken,
  getClients,
  isAuthError,
  jiraRequest,
  release
} from './client'
import { shouldSurfaceSiteFailure } from './issues'

type JiraRecord = Record<string, unknown>

function mapSavedFilter(site: JiraSite, raw: JiraRecord): JiraSavedFilter | null {
  const id =
    typeof raw.id === 'string'
      ? raw.id
      : typeof raw.id === 'number' && Number.isFinite(raw.id)
        ? String(raw.id)
        : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const jql = typeof raw.jql === 'string' ? raw.jql : ''
  // A filter without JQL cannot be executed (expand missing or restricted) — drop it.
  if (!id || !name.trim() || !jql.trim()) {
    return null
  }
  return {
    id,
    name,
    jql,
    siteId: site.id,
    siteName: site.displayName,
    favourite: raw.favourite === true ? true : undefined
  }
}

/**
 * Lists the user's saved Jira filters (owned and favourites) with their JQL,
 * so the Tasks panel can run them through the regular issue-search path.
 */
export async function listSavedFilters(
  siteId?: JiraSiteSelection | null
): Promise<JiraSavedFilter[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        // Server/DC has no /filter/my; /filter/favourite covers owned + starred filters.
        const path =
          entry.site.authType === 'server'
            ? `${apiBasePath(entry.site)}/filter/favourite?expand=jql`
            : '/rest/api/3/filter/my?expand=jql&includeFavourites=true'
        const records = await jiraRequest<JiraRecord[]>(entry, path)
        return (Array.isArray(records) ? records : [])
          .map((record) => mapSavedFilter(entry.site, record))
          .filter((filter): filter is JiraSavedFilter => filter !== null)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[jira] listSavedFilters failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  const seen = new Set<string>()
  return results
    .flat()
    .filter((filter) => {
      const key = `${filter.siteId}:${filter.id}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
