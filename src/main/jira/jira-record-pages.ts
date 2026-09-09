import { jiraRequest, type JiraClientForSite } from './authenticated-request'

export type JiraRecord = Record<string, unknown>

export type JiraSearchResponse = {
  issues?: JiraRecord[]
}

export type JiraPagedResponse<T> = {
  startAt?: number
  maxResults?: number
  total?: number
  isLast?: boolean
  values?: T[]
  issueTypes?: T[]
  comments?: T[]
  fields?: T[] | Record<string, T>
}

export type JiraPageItemKey = 'values' | 'issueTypes' | 'comments'

export function asRecord(value: unknown): JiraRecord {
  return value && typeof value === 'object' ? (value as JiraRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asIdentifier(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function getPageItems<T>(response: JiraPagedResponse<T>, key: JiraPageItemKey): T[] {
  const keyedItems = response[key]
  if (Array.isArray(keyedItems)) {
    return keyedItems
  }
  return response.values ?? []
}

export function shouldFetchNextPage<T>(
  response: JiraPagedResponse<T>,
  startAt: number,
  items: T[],
  requestedMaxResults: number
): boolean {
  if (response.isLast === true || items.length === 0) {
    return false
  }
  const total = asFiniteNumber(response.total)
  const pageSize = asFiniteNumber(response.maxResults)
  if (total !== null) {
    return startAt + items.length < total && (pageSize ?? requestedMaxResults) > 0
  }
  if (response.isLast === false) {
    return (pageSize ?? requestedMaxResults) > 0
  }
  return pageSize !== null && items.length >= pageSize
}

export async function fetchPagedRecords(
  entry: JiraClientForSite,
  key: JiraPageItemKey,
  pathForPage: (startAt: number, maxResults: number) => string,
  maxResults = 100
): Promise<JiraRecord[]> {
  const records: JiraRecord[] = []
  let startAt = 0
  for (let guard = 0; guard < 100; guard += 1) {
    const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      pathForPage(startAt, maxResults)
    )
    const items = getPageItems(response, key)
    records.push(...items)
    if (!shouldFetchNextPage(response, startAt, items, maxResults)) {
      break
    }
    startAt += asFiniteNumber(response.maxResults) ?? maxResults
  }
  return records
}
