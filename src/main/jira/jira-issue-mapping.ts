import type {
  JiraCreateField,
  JiraCreateFieldAllowedValue,
  JiraIssue,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraSite,
  JiraStatus,
  JiraUser
} from '../../shared/jira-types'
import { adfToMarkdownText, textToAdf, type AdfToMarkdownOptions } from './adf-markdown'
import {
  asRecord,
  asString,
  asStringArray,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'

export const ISSUE_FIELDS = [
  'summary',
  'description',
  'project',
  'issuetype',
  'status',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'created',
  'updated'
]

// Why: list/typeahead only need identity + metadata; description ADF parse is the hot-path cost.
export const ISSUE_LIST_FIELDS = ISSUE_FIELDS.filter((field) => field !== 'description')

// Why: detail reads need attachment metadata so inline ADF media can be resolved
// to downloadable image content; list/search omit this for payload size.
export const ISSUE_DETAIL_FIELDS = [...ISSUE_FIELDS, 'attachment']
// `created`/`updated` are required: mapJiraIssue falls back to "now" when they're absent,
// which would silently report the lookup time as the issue's timestamps.
export const ISSUE_SUMMARY_FIELDS = [
  'summary',
  'project',
  'issuetype',
  'status',
  'created',
  'updated'
]
export function avatarUrl(value: unknown): string | undefined {
  const avatars = asRecord(value)
  return (
    asString(avatars['48x48']) ||
    asString(avatars['32x32']) ||
    asString(avatars['24x24']) ||
    undefined
  )
}

export function mapUser(value: unknown): JiraUser | undefined {
  const user = asRecord(value)
  // Server/DC users have no accountId; name (login) and key are its stable ids.
  const accountId = asString(user.accountId) || asString(user.name) || asString(user.key)
  if (!accountId) {
    return undefined
  }
  return {
    accountId,
    displayName: asString(user.displayName, 'Unknown'),
    email: typeof user.emailAddress === 'string' ? user.emailAddress : undefined,
    avatarUrl: avatarUrl(user.avatarUrls)
  }
}

export function mapProject(value: unknown, site?: JiraSite): JiraProject {
  const project = asRecord(value)
  return {
    id: asString(project.id),
    key: asString(project.key),
    name: asString(project.name, asString(project.key)),
    siteId: site?.id,
    siteName: site?.displayName
  }
}

export function mapIssueType(value: unknown): JiraIssueType {
  const issueType = asRecord(value)
  return {
    id: asString(issueType.id),
    name: asString(issueType.name, 'Issue'),
    description: asString(issueType.description) || undefined,
    iconUrl: asString(issueType.iconUrl) || undefined,
    subtask: typeof issueType.subtask === 'boolean' ? issueType.subtask : undefined
  }
}

export function mapCreateFieldAllowedValue(value: unknown): JiraCreateFieldAllowedValue {
  const option = asRecord(value)
  return {
    id: asString(option.id) || undefined,
    value: asString(option.value) || undefined,
    name: asString(option.name) || undefined
  }
}

export function mapCreateField(value: unknown, fallbackKey = ''): JiraCreateField | null {
  const field = asRecord(value)
  const schema = asRecord(field.schema)
  const key =
    asString(field.key) ||
    asString(field.fieldId) ||
    asString(field.id) ||
    asString(field.fieldKey) ||
    fallbackKey
  if (!key) {
    return null
  }
  const allowedValues = Array.isArray(field.allowedValues)
    ? field.allowedValues.map(mapCreateFieldAllowedValue)
    : undefined
  return {
    key,
    name: asString(field.name, key),
    required: field.required === true,
    schema: {
      type: asString(schema.type) || undefined,
      items: asString(schema.items) || undefined,
      custom: asString(schema.custom) || undefined
    },
    allowedValues
  }
}

export function getCreateFieldRecords(response: JiraPagedResponse<JiraRecord>): JiraRecord[] {
  if (Array.isArray(response.values)) {
    return response.values
  }
  if (Array.isArray(response.fields)) {
    return response.fields
  }
  if (response.fields && typeof response.fields === 'object') {
    return Object.entries(response.fields).map(([key, value]) => ({
      key,
      ...asRecord(value)
    }))
  }
  return []
}

export function mapPriority(value: unknown): JiraPriority | undefined {
  const priority = asRecord(value)
  const id = asString(priority.id)
  if (!id) {
    return undefined
  }
  return {
    id,
    name: asString(priority.name, 'Priority'),
    iconUrl: asString(priority.iconUrl) || undefined
  }
}

export function mapStatus(value: unknown): JiraStatus {
  const status = asRecord(value)
  const category = asRecord(status.statusCategory)
  return {
    id: asString(status.id),
    name: asString(status.name, 'Unknown'),
    categoryKey: asString(category.key, 'undefined'),
    categoryName: asString(category.name, 'No Category'),
    colorName: asString(category.colorName) || undefined
  }
}

export function issueUrl(site: JiraSite, key: string): string {
  return `${site.siteUrl}/browse/${encodeURIComponent(key)}`
}

// REST v2 (Server/DC) bodies are plain text; v3 (Cloud) requires ADF documents.
export function toBodyText(site: JiraSite, text: string): unknown {
  return site.authType === 'server' ? text : textToAdf(text)
}

export function mapJiraIssue(
  site: JiraSite,
  raw: JiraRecord,
  adfOptions?: AdfToMarkdownOptions
): JiraIssue {
  const fields = asRecord(raw.fields)
  const key = asString(raw.key)
  return {
    id: asString(raw.id, key),
    key,
    siteId: site.id,
    siteName: site.displayName,
    title: asString(fields.summary, key || 'Untitled issue'),
    description: adfToMarkdownText(fields.description, adfOptions),
    url: issueUrl(site, key),
    project: mapProject(fields.project, site),
    issueType: mapIssueType(fields.issuetype),
    status: mapStatus(fields.status),
    labels: asStringArray(fields.labels),
    assignee: mapUser(fields.assignee),
    reporter: mapUser(fields.reporter),
    priority: mapPriority(fields.priority),
    createdAt: asString(fields.created, new Date().toISOString()),
    updatedAt: asString(fields.updated, new Date().toISOString())
  }
}
