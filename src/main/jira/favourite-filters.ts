import {
  normalizeJiraFavouriteFilters,
  type JiraFavouriteFilterList
} from '../../shared/jira-favourite-filters'
import { JiraFavouriteFilterParams } from '../../shared/rpc-contract/jira-favourite-filter-params'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { getClients } from './client'
import { requireStrictJiraSite, withJiraDeadline } from './jira-read-failure'
import { acquire, release } from './request-queue'

export async function listFavouriteFilters(
  siteId: string,
  signal?: AbortSignal
): Promise<JiraFavouriteFilterList> {
  const selection = JiraFavouriteFilterParams.parse({ siteId }).siteId
  const entries = getClients(selection)
  requireStrictJiraSite(entries, selection, true)
  const entry = entries[0]
  return withJiraDeadline(signal, 25_000, async (deadlineSignal) => {
    await acquire(deadlineSignal)
    try {
      const value = await jiraRequest<unknown>(
        entry,
        `${apiBasePath(entry.site)}/filter/favourite?expand=jql`,
        { signal: deadlineSignal },
        2 * 1024 * 1024
      )
      return normalizeJiraFavouriteFilters(value, selection)
    } finally {
      release()
    }
  })
}
