import type { JiraUser } from '../../shared/jira/jira-types'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { mapUser } from './jira-issue-mapping'
import { asFiniteNumber, asRecord, asString, type JiraRecord } from './jira-record-pages'

function changelogHistories(changelog: unknown): unknown[] {
  const page = asRecord(changelog)
  if (Array.isArray(page.histories)) {
    return page.histories
  }
  if (Array.isArray(page.values)) {
    return page.values
  }
  return []
}

function pageReachesEnd(changelog: unknown): boolean {
  const histories = changelogHistories(changelog)
  if (histories.length === 0) {
    return false
  }
  const total = asFiniteNumber(asRecord(changelog).total)
  if (total === null) {
    return true
  }
  const startAt = asFiniteNumber(asRecord(changelog).startAt) ?? 0
  return startAt + histories.length >= total
}

// Jira returns changelog oldest-first. A page that ends before `total` is not the latest edit.
export function latestEditorFromChangelog(changelog: unknown): JiraUser | undefined {
  if (!pageReachesEnd(changelog)) {
    return undefined
  }
  const author = asRecord(asRecord(changelogHistories(changelog).at(-1)).author)
  if (!asString(author.displayName).trim()) {
    return undefined
  }
  return mapUser(author)
}

export function changelogTailStart(changelog: unknown): number | null {
  const total = asFiniteNumber(asRecord(changelog).total)
  const histories = changelogHistories(changelog)
  if (total === null || total <= 0 || histories.length === 0 || pageReachesEnd(changelog)) {
    return null
  }
  return total - 1
}

export async function readLatestIssueEditor(
  entry: JiraClientForSite,
  issue: JiraRecord
): Promise<JiraUser | undefined> {
  const embedded = latestEditorFromChangelog(issue.changelog)
  if (embedded) {
    return embedded
  }
  const tail = changelogTailStart(issue.changelog)
  const key = asString(issue.key)
  if (tail === null || !key) {
    return undefined
  }
  const params = new URLSearchParams({ maxResults: '1', startAt: String(tail) })
  const page = asRecord(
    await jiraRequest(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/changelog?${params.toString()}`
    )
  )
  // The tail request already selected the last row. Keep that index if the payload omits it.
  if (asFiniteNumber(page.startAt) === null) {
    page.startAt = tail
  }
  return latestEditorFromChangelog(page)
}
