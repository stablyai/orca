import { mantisBTRequest, type MantisBTClientForSite } from './authenticated-request'

export type MantisBTRecord = Record<string, unknown>

type MantisBTIssuesResponse = {
  issues?: MantisBTRecord[]
}

export function asRecord(value: unknown): MantisBTRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by the `typeof value === 'object'` check in the ternary condition above; every field read off the result is re-validated with `typeof` before use.
  return value && typeof value === 'object' ? (value as MantisBTRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class MantisBTPaginationLimitError extends Error {
  constructor() {
    super('MantisBT issue list exceeded the pagination safety limit; narrow the query.')
    this.name = 'MantisBTPaginationLimitError'
  }
}

// Why: a live server can truncate a page's response body mid-transmission
// under load (confirmed against a real 2,500+ issue project: response.ok
// but response.json() throws SyntaxError) — transient, not a real HTTP
// error, so a bounded retry recovers most of these without surfacing a
// failure the user has to manually retry. Real HTTP errors (401/500/...)
// and cancellation are not retried; retrying those wastes the deadline on
// a failure that will not change.
const MAX_PAGE_FETCH_ATTEMPTS = 3
const PAGE_RETRY_DELAY_MS = 500

async function fetchIssuePage(
  entry: MantisBTClientForSite,
  path: string,
  signal: AbortSignal | undefined
): Promise<MantisBTIssuesResponse> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mantisBTRequest<MantisBTIssuesResponse>(entry, path, { signal })
    } catch (error) {
      const retryable = error instanceof SyntaxError && !signal?.aborted
      if (!retryable || attempt >= MAX_PAGE_FETCH_ATTEMPTS) {
        throw error
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, PAGE_RETRY_DELAY_MS)
      await promise
    }
  }
}

// MantisBT's issue listing has no cursor/total envelope to detect the last
// page from, so a short page (fewer than requested, including empty) is the
// only reliable "no more results" signal. The 500-page ceiling is a safety
// net against a server that never returns a short page — hitting it throws
// instead of silently returning a truncated result set, since a MantisBT
// instance can legitimately have more than 25,000 issues on one project.
//
// Why onPage: a large project can take minutes to fully page through (see
// ISSUE_SEARCH_TIMEOUT_MS in mantisbt-issue-search.ts) — reporting each
// page's records as they arrive lets the caller show issues incrementally
// instead of a blank spinner for the whole fetch, and lets it keep
// already-fetched issues visible if a later page fails outright.
export async function fetchAllIssuePages(
  entry: MantisBTClientForSite,
  pathForPage: (page: number, pageSize: number) => string,
  pageSize = 50,
  signal?: AbortSignal,
  onPage?: (pageRecords: MantisBTRecord[]) => void
): Promise<MantisBTRecord[]> {
  const records: MantisBTRecord[] = []
  for (let page = 1, guard = 0; ; page += 1, guard += 1) {
    if (guard >= 500) {
      throw new MantisBTPaginationLimitError()
    }
    const response = await fetchIssuePage(entry, pathForPage(page, pageSize), signal)
    const items = Array.isArray(response.issues) ? response.issues : []
    records.push(...items)
    onPage?.(items)
    if (items.length < pageSize) {
      break
    }
  }
  return records
}
