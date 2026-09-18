import { sortByUpdatedAtDescending } from '../../shared/updated-at-order'
import type {
  MantisBTIssue,
  MantisBTIssueFilter,
  MantisBTSiteSelection
} from '../../shared/mantisbt-types'
import { acquire, release } from './request-queue'
import { apiBasePath, mantisBTRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapMantisBTIssue } from './mantisbt-issue-mapping'
import { fetchAllIssuePages } from './mantisbt-record-pages'
import {
  evictSiteTokenSafely,
  shouldSurfaceSiteFailure,
  withMantisBTDeadline
} from './mantisbt-read-failure'
import { toViewer } from './site-identity'
import type { MantisBTReadFailure } from './mantisbt-read-failure'

// Why: fetchAllIssuePages fetches every page of a site's issue list (no
// server-side handler_id/reporter_id filter exists to narrow the request —
// see below; project_id IS respected server-side and is the recommended way
// for a caller to narrow a large multi-project instance's fetch), and a
// large self-hosted instance's per-page latency can climb with page depth: a
// live server with 1000+ issues measured page 1 at ~2.8s growing to ~11s by
// page 20, extrapolating to several minutes for the full unscoped listing.
// The request is cancelable (preset/site switch or navigating away aborts
// and is ignored by the renderer), so a generous ceiling here trades a long
// wait for a real server response instead of a premature failure.
const ISSUE_SEARCH_TIMEOUT_MS = 300_000

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

export async function listIssues(
  filter: MantisBTIssueFilter = 'assigned',
  limit = 30,
  siteId?: MantisBTSiteSelection | null,
  projectId?: string | null,
  signal?: AbortSignal,
  // Why: only wired for a single connected/selected site — an 'all sites'
  // fan-out would need to interleave multiple sites' running totals into
  // one ordered list, which isn't worth the complexity for the rare
  // multi-site case (mirrors the same simplification the nested-repo-scan
  // and workspace-space progress channels already make).
  onProgress?: (issues: MantisBTIssue[]) => void
): Promise<MantisBTIssue[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const reportProgress = entries.length === 1 ? onProgress : undefined
  const failures: (MantisBTReadFailure | undefined)[] = Array.from({ length: entries.length })
  const results = await withMantisBTDeadline(signal, ISSUE_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index): Promise<MantisBTIssue[]> => {
        await acquire(requestSignal)
        try {
          // MantisBT's REST API has no server-side handler_id/reporter_id filter, so
          // 'assigned'/'reported' resolve the viewer's numeric id once per site here
          // and filter the fetched page client-side below.
          const viewerId =
            filter === 'all'
              ? null
              : toViewer(
                  await mantisBTRequest(
                    entry,
                    `${apiBasePath(entry.site.usePhpIndexPath)}/users/me`,
                    {
                      signal: requestSignal
                    }
                  )
                ).id
          const filterByViewer = (issues: MantisBTIssue[]): MantisBTIssue[] => {
            if (filter === 'assigned') {
              return issues.filter((issue) => issue.handler?.id === viewerId)
            }
            if (filter === 'reported') {
              return issues.filter((issue) => issue.reporter?.id === viewerId)
            }
            return issues
          }
          const accumulated: MantisBTIssue[] = []
          const records = await fetchAllIssuePages(
            entry,
            (page, pageSize) => {
              const params = new URLSearchParams({
                page: String(page),
                page_size: String(pageSize)
              })
              if (projectId) {
                params.set('project_id', projectId)
              }
              return `${apiBasePath(entry.site.usePhpIndexPath)}/issues?${params.toString()}`
            },
            50,
            requestSignal,
            reportProgress
              ? (pageRecords) => {
                  accumulated.push(
                    ...pageRecords.map((record) => mapMantisBTIssue(entry.site, record))
                  )
                  reportProgress(filterByViewer(accumulated))
                }
              : undefined
          )
          const issues = records.map((record) => mapMantisBTIssue(entry.site, record))
          return filterByViewer(issues)
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a site failure, so don't clear tokens or mask a real one.
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            evictSiteTokenSafely(clearToken, entry.site.id)
          }
          if (surfaceSiteFailure) {
            throw error
          }
          console.warn('[mantisBT] listIssues failed:', error)
          failures[index] = { error, auth: authFailure }
          return []
        } finally {
          release()
        }
      })
    )
  )
  // 'all' fan-out: only surface an error when every connected site failed, so a
  // partial success (or a genuinely empty result) is not reported as an error.
  const recordedFailures = failures.filter(
    (failure): failure is MantisBTReadFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length && entries.length > 0) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return sortByUpdatedAtDescending(results.flat()).slice(0, safeLimit)
}
