import type { JiraEditField } from '../../shared/jira/jira-types'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapEditField } from './jira-issue-edit-field-values'
import { requireStrictJiraSite } from './jira-read-failure'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'
import { acquire, release } from './request-queue'

// Fields the issue sheet already edits, or that Jira changes through other APIs.
const EXCLUDED_FIELD_KEYS = new Set([
  'summary',
  'labels',
  'assignee',
  'priority',
  'status',
  'issuetype',
  'project',
  'comment',
  'attachment',
  'issuelinks',
  'worklog',
  'timetracking',
  'parent',
  'subtasks',
  'watches',
  'votes'
])
const EXCLUDED_CUSTOM_TYPES = new Set(['com.pyxis.greenhopper.jira:gh-lexo-rank'])

function isListedEditField(fieldKey: string, meta: unknown): boolean {
  const custom = asString(asRecord(asRecord(meta).schema).custom)
  return !EXCLUDED_FIELD_KEYS.has(fieldKey) && !EXCLUDED_CUSTOM_TYPES.has(custom)
}

/**
 * Reads the issue's edit screen (editmeta) and the current value of each field
 * on it. Values are read by key so the request skips comments and attachments.
 */
export async function getIssueEditFields(
  key: string,
  siteId?: string | null,
  strict = false,
  includeRaw = false
): Promise<JiraEditField[]> {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  const entry = entries[0]
  if (!entry) {
    return []
  }
  let metaEntries: [string, JiraRecord][] = []
  let values: JiraRecord = {}
  await acquire()
  try {
    const issueBase = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}`
    const editmeta = await jiraRequest<JiraRecord>(entry, `${issueBase}/editmeta`)
    metaEntries = Object.entries(asRecord(editmeta.fields))
      .filter(([fieldKey, meta]) => isListedEditField(fieldKey, meta))
      .map(([fieldKey, meta]) => [fieldKey, asRecord(meta)])
    if (metaEntries.length > 0) {
      const params = new URLSearchParams({
        fields: metaEntries.map(([fieldKey]) => fieldKey).join(',')
      })
      const issue = await jiraRequest<JiraRecord>(entry, `${issueBase}?${params.toString()}`)
      values = asRecord(issue.fields)
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getIssueEditFields failed:', error)
    if (strict) {
      throw error
    }
    return []
  } finally {
    release()
  }
  // Why: rich-text round-trip checks parse Markdown; keep them off the request pool.
  const fields = await Promise.all(
    metaEntries.map(([fieldKey, meta]) =>
      mapEditField(entry.site, fieldKey, meta, values[fieldKey], includeRaw)
    )
  )
  return fields.filter((field): field is JiraEditField => field !== null)
}
