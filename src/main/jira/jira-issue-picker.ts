import { isUtf8ByteLengthWithinLimit } from '../../shared/utf8-byte-limits'
import { JIRA_ISSUE_KEY_PATTERN } from '../../shared/jira/jira-issue-url'
import { appendJiraJqlPredicate } from '../../shared/jira/jira-jql-predicate'
import type { JiraIssueSuggestions } from '../../shared/jira/jira-types'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { asRecord } from './jira-record-pages'

const MAX_ISSUE_SUGGESTION_KEYS = 100

export async function readIssueSuggestionJql(
  entry: JiraClientForSite,
  suggestions: JiraIssueSuggestions,
  signal: AbortSignal
): Promise<string | null> {
  const query = suggestions.query.trim()
  if (!/^\d+$/.test(query)) {
    return null
  }
  const params = new URLSearchParams({
    query,
    currentJQL: suggestions.currentJql,
    showSubTasks: 'true'
  })
  const response = await jiraRequest<unknown>(
    entry,
    `${apiBasePath(entry.site)}/issue/picker?${params}`,
    { signal }
  )
  const sections: unknown = asRecord(response).sections
  if (!Array.isArray(sections)) {
    throw new Error('Jira returned invalid issue suggestions.')
  }
  const keys = new Set<string>()
  for (const section of sections) {
    const issues: unknown = asRecord(section).issues
    if (!Array.isArray(issues)) {
      throw new Error('Jira returned invalid issue suggestions.')
    }
    for (const issue of issues) {
      const key = asRecord(issue).key
      if (typeof key !== 'string') {
        throw new Error('Jira returned invalid issue suggestions.')
      }
      if (JIRA_ISSUE_KEY_PATTERN.test(key) && key.endsWith(`-${query}`)) {
        keys.add(key.toUpperCase())
        if (keys.size > MAX_ISSUE_SUGGESTION_KEYS) {
          throw new Error(
            'Jira issue suggestions exceeded the candidate limit. Select a project instead.'
          )
        }
      }
    }
  }
  if (keys.size === 0) {
    return null
  }
  // History suggestions may ignore currentJQL; enforce its scope again when reading details.
  const jql = appendJiraJqlPredicate(
    suggestions.currentJql,
    `key in (${[...keys].map((key) => JSON.stringify(key)).join(', ')})`
  )
  if (!isUtf8ByteLengthWithinLimit(jql, 8192)) {
    throw new Error('Jira issue suggestion query exceeded the length limit.')
  }
  return jql
}
