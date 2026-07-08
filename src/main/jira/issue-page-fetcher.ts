import { jiraRequest, type JiraClientForSite } from './client'
import {
  getPageItems,
  shouldFetchNextPage,
  type JiraPageItemKey,
  type JiraPagedResponse,
  type JiraRecord
} from './issue-mappers'

type JiraPageItemSelector =
  | JiraPageItemKey
  | ((response: JiraPagedResponse<JiraRecord>) => JiraRecord[])

export async function fetchPagedRecords(
  entry: JiraClientForSite,
  itemSelector: JiraPageItemSelector,
  pathForPage: (startAt: number, maxResults: number) => string,
  maxResults = 100
): Promise<JiraRecord[]> {
  const records: JiraRecord[] = []
  let startAt = 0
  let truncated = true
  for (let guard = 0; guard < 100; guard += 1) {
    const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      pathForPage(startAt, maxResults)
    )
    const items =
      typeof itemSelector === 'function'
        ? itemSelector(response)
        : getPageItems(response, itemSelector)
    records.push(...items)
    if (!shouldFetchNextPage(response, startAt, items, maxResults)) {
      truncated = false
      break
    }
    // Why: Jira may return short pages while more records remain; advancing by
    // the requested page size can skip records.
    startAt += items.length
  }
  if (truncated) {
    console.warn(
      '[jira] fetchPagedRecords hit the pagination guard limit; results may be truncated.'
    )
  }
  return records
}
