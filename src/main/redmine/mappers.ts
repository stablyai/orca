import type {
  RedmineCustomField,
  RedmineIssue,
  RedmineProject,
  RedmineUser
} from '../../shared/redmine-types'
import { normalizeRedmineUrl } from './redmine-request'

// Raw payload shapes as Redmine's REST API returns them. Field names use the
// server's snake_case; keep them here so the mapper stays a one-way, typed view.

type RawIdName = { id: number; name?: string }
type RawUser = { id: number; name?: string; login?: string }
type RawProject = { id: number; name?: string; identifier?: string }

export type RawRedmineIssue = {
  id: number
  project?: RawProject
  tracker?: RawIdName
  status?: RawIdName & { is_closed?: boolean }
  priority?: RawIdName
  author?: RawUser
  assigned_to?: RawUser
  subject?: string
  description?: string | null
  start_date?: string | null
  due_date?: string | null
  done_ratio?: number
  estimated_hours?: number | null
  spent_hours?: number | null
  created_on?: string
  updated_on?: string
  closed_on?: string | null
  custom_fields?: { id: number; name?: string; value?: unknown }[]
}

export type RawRedmineIssueList = { issues?: RawRedmineIssue[]; total_count?: number }

export type RawRedmineIssueDetail = { issue?: RawRedmineIssue }

export type RawRedmineUser = {
  user?: { id: number; firstname?: string; lastname?: string; login?: string }
}

export function mapRedmineProject(raw?: RawProject): RedmineProject | null {
  if (!raw || typeof raw.id !== 'number') {
    return null
  }
  return { id: raw.id, name: raw.name ?? `Project ${raw.id}`, identifier: raw.identifier }
}

export function mapRedmineUser(raw?: RawUser): RedmineUser | null {
  if (!raw || typeof raw.id !== 'number') {
    return null
  }
  return { id: raw.id, name: raw.name ?? `User ${raw.id}`, login: raw.login ?? null }
}

export function mapRedmineIssue(raw: RawRedmineIssue, siteUrl: string): RedmineIssue {
  const project = mapRedmineProject(raw.project)
  const author = mapRedmineUser(raw.author)
  const assignedTo = mapRedmineUser(raw.assigned_to)
  return {
    id: raw.id,
    subject: raw.subject ?? '',
    project: project ?? { id: 0, identifier: undefined, name: '' },
    tracker: { id: raw.tracker?.id ?? 0, name: raw.tracker?.name ?? '' },
    status: {
      id: raw.status?.id ?? 0,
      name: raw.status?.name ?? '',
      isClosed: raw.status?.is_closed ?? false
    },
    priority: { id: raw.priority?.id ?? 0, name: raw.priority?.name ?? '' },
    author: author ?? { id: 0, name: '', login: null },
    assignedTo,
    description: raw.description != null ? String(raw.description) : null,
    startDate: raw.start_date ?? null,
    dueDate: raw.due_date ?? null,
    doneRatio: raw.done_ratio ?? 0,
    estimatedHours: raw.estimated_hours ?? null,
    spentHours: raw.spent_hours ?? null,
    createdOn: raw.created_on ?? '',
    updatedOn: raw.updated_on ?? '',
    closedOn: raw.closed_on ?? null,
    customFields: mapRedmineCustomFields(raw.custom_fields),
    url: `${normalizeRedmineUrl(siteUrl)}/issues/${raw.id}`
  }
}

function mapRedmineCustomFields(
  rawFields?: { id: number; name?: string; value?: unknown }[]
): RedmineCustomField[] {
  if (!Array.isArray(rawFields)) {
    return []
  }
  const fields: RedmineCustomField[] = []
  for (const field of rawFields) {
    if (typeof field.id !== 'number') {
      continue
    }
    // Redmine returns array/multi-select values as arrays and booleans as
    // strings; write them through verbatim so the renderer can display them.
    fields.push({
      id: field.id,
      name: typeof field.name === 'string' ? field.name : `Custom field ${field.id}`,
      value: field.value == null ? null : (field.value as RedmineCustomField['value'])
    })
  }
  return fields
}
