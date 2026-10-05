import type { MantisBTIssue, MantisBTSiteSelection } from '../../shared/mantisbt-types'
import { acquire, release } from './request-queue'
import { apiBasePath, mantisBTRequest, MantisBTApiError } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapMantisBTIssue } from './mantisbt-issue-mapping'
import {
  evictSiteTokenSafely,
  shouldSurfaceSiteFailure,
  withMantisBTDeadline
} from './mantisbt-read-failure'
import type { MantisBTRecord } from './mantisbt-record-pages'

const ISSUE_READ_TIMEOUT_MS = 30_000

type MantisBTIssueResponse = {
  issues?: MantisBTRecord[]
}

export async function getIssue(
  id: string,
  siteId?: MantisBTSiteSelection | null,
  signal?: AbortSignal
): Promise<MantisBTIssue | null> {
  const entries = getClients(siteId)
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  return withMantisBTDeadline(signal, ISSUE_READ_TIMEOUT_MS, async (requestSignal) => {
    let sawFailure = false
    let firstNonAuthFailure: unknown
    for (const entry of entries) {
      await acquire(requestSignal)
      try {
        const response = await mantisBTRequest<MantisBTIssueResponse>(
          entry,
          `${apiBasePath(entry.site.usePhpIndexPath)}/issues/${encodeURIComponent(id)}`,
          { signal: requestSignal }
        )
        const issue = response.issues?.[0]
        if (issue) {
          return mapMantisBTIssue(entry.site, issue)
        }
      } catch (error) {
        // Why: a 404 means this site doesn't have the issue, not a site
        // failure — it does not count toward "every connected site failed".
        if (error instanceof MantisBTApiError && error.status === 404) {
          continue
        }
        if (requestSignal.aborted) {
          throw error
        }
        const authFailure = isAuthError(error)
        if (authFailure) {
          evictSiteTokenSafely(clearToken, entry.site.id)
        }
        if (surfaceSiteFailure) {
          throw error
        }
        sawFailure = true
        firstNonAuthFailure ??= authFailure ? undefined : error
        console.warn('[mantisBT] getIssue failed:', error)
      } finally {
        release()
      }
    }
    if (sawFailure && entries.length > 0) {
      throw firstNonAuthFailure ?? new Error('Could not reach any connected MantisBT site.')
    }
    return null
  })
}
