import type { JiraIssue, JiraSiteSelection } from '../../shared/jira-types'
import { JiraSummaryLookupError } from '../../shared/jira-summary-lookup'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { ISSUE_DETAIL_FIELDS, ISSUE_SUMMARY_FIELDS, mapJiraIssue } from './jira-issue-mapping'
import {
  collectIssueMediaRequest,
  flushMediaResolutionWarn,
  prepareMediaResolver,
  type MediaRequest
} from './jira-issue-media'
import type { JiraRecord } from './jira-record-pages'
import {
  getErrorStatus,
  settleJiraSummaryRead,
  shouldSurfaceSiteFailure,
  withJiraDeadline
} from './jira-read-failure'

const ISSUE_SUMMARY_TIMEOUT_MS = 30_000

export async function getIssue(
  key: string,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue | null> {
  const entries = getClients(siteId)
  for (const entry of entries) {
    let mediaRequest: MediaRequest | undefined
    let issue: JiraRecord | undefined
    let held = false
    try {
      await acquire()
      held = true
      const params = new URLSearchParams({
        fields: ISSUE_DETAIL_FIELDS.join(','),
        expand: 'renderedFields'
      })
      issue = await jiraRequest<JiraRecord>(
        entry,
        `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?${params.toString()}`
      )
      // Why: keep only JSON under the pool; binary downloads fan out after release.
      mediaRequest = collectIssueMediaRequest(issue)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        if (shouldSurfaceSiteFailure(siteId, entries.length)) {
          throw error
        }
      } else {
        console.warn('[jira] getIssue failed:', error)
      }
      continue
    } finally {
      if (held) {
        held = false
        release()
      }
    }

    try {
      if (!issue) {
        continue
      }
      const prepared = mediaRequest ? await prepareMediaResolver(entry, mediaRequest) : undefined
      const mapped = mapJiraIssue(entry.site, issue, prepared?.options)
      if (prepared) {
        flushMediaResolutionWarn(entry, prepared)
      }
      return mapped
    } catch (error) {
      console.warn('[jira] getIssue media load failed:', error)
      return mapJiraIssue(entry.site, issue)
    }
  }
  return null
}

export async function getIssueSummary(
  key: string,
  siteId: string,
  signal?: AbortSignal
): Promise<JiraIssue | null> {
  let entries: JiraClientForSite[]
  try {
    entries = getClients(siteId)
  } catch (error) {
    throw new JiraSummaryLookupError('auth', error)
  }
  const entry = entries.find((candidate) => candidate.site.id === siteId)
  if (!entry) {
    throw new JiraSummaryLookupError('disconnected')
  }

  return withJiraDeadline(signal, ISSUE_SUMMARY_TIMEOUT_MS, async (requestSignal) => {
    await acquire(requestSignal)
    try {
      const params = new URLSearchParams({ fields: ISSUE_SUMMARY_FIELDS.join(',') })
      const issue = await settleJiraSummaryRead(
        jiraRequest<JiraRecord>(
          entry,
          `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?${params.toString()}`,
          { signal: requestSignal }
        ),
        requestSignal
      )
      return mapJiraIssue(entry.site, issue)
    } catch (error) {
      if (isAuthError(error)) {
        throw new JiraSummaryLookupError('auth', error)
      }
      if (getErrorStatus(error) === 404) {
        throw new JiraSummaryLookupError('not-found', error)
      }
      throw new JiraSummaryLookupError('read-failed', error)
    } finally {
      release()
    }
  })
}
