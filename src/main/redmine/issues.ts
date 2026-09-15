import type {
  RedmineIssue,
  RedmineIssueCollectionResult,
  RedmineListFilter
} from '../../shared/redmine-types'
import { classifyRedmineError, redmineRequest, type RedmineApiError } from './redmine-request'
import { mapRedmineIssue, type RawRedmineIssueDetail, type RawRedmineIssueList } from './mappers'

const LIST_REQUEST_TIMEOUT_MS = 8000
const DETAIL_REQUEST_TIMEOUT_MS = 8000

/**
 * Lists issues for a site, read-only. List responses deliberately avoid
 * `include=journals/attachments` to keep payloads small; the detail lookup
 * adds them.
 */
export async function listRedmineIssues(
  siteUrl: string,
  apiKey: string,
  filter: RedmineListFilter = {}
): Promise<RedmineIssueCollectionResult> {
  const params = new URLSearchParams()
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 20), 1), 100)
  const page = Math.max(Math.floor(filter.page ?? 1), 1)
  params.set('limit', String(limit))
  params.set('offset', String((page - 1) * limit))

  if (filter.scope === 'assigned') {
    params.set('assigned_to_id', 'me')
  } else if (filter.scope === 'created') {
    params.set('author_id', 'me')
  }
  if (filter.state === 'open' || filter.state === 'closed') {
    params.set('status_id', filter.state)
  }

  try {
    const data = await redmineRequest<RawRedmineIssueList>(
      siteUrl,
      apiKey,
      `/issues.json?${params.toString()}`,
      { signal: AbortSignal.timeout(LIST_REQUEST_TIMEOUT_MS) }
    )
    const items = (data?.issues ?? []).map((issue) => mapRedmineIssue(issue, siteUrl))
    return { items, totalCount: data?.total_count ?? items.length }
  } catch (error) {
    handleRedmineError(error)
  }
}

export async function getRedmineIssue(
  siteUrl: string,
  apiKey: string,
  issueId: number
): Promise<RedmineIssue | null> {
  try {
    const data = await redmineRequest<RawRedmineIssueDetail>(
      siteUrl,
      apiKey,
      `/issues/${issueId}.json?include=journals,attachments`,
      { signal: AbortSignal.timeout(DETAIL_REQUEST_TIMEOUT_MS) }
    )
    return data?.issue ? mapRedmineIssue(data.issue, siteUrl) : null
  } catch (error) {
    handleRedmineError(error)
  }
}

function handleRedmineError(error: unknown): never {
  const classified = classifyRedmineError(error)
  const apiError = error as RedmineApiError
  throw new RedmineRequestError(classified, apiError.status ?? classified.status ?? null)
}

export class RedmineRequestError extends Error {
  readonly classified: RedmineIssueCollectionResult['error']
  readonly status: number | null

  constructor(classified: RedmineIssueCollectionResult['error'], status: number | null) {
    super(classified?.message ?? 'Redmine request failed')
    this.name = 'RedmineRequestError'
    this.classified = classified
    this.status = status
  }
}
