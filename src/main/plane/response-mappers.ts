import type { PlaneClientForInstance } from './client'
import { planeWebUrl } from './api-request'
import type {
  PlaneIssueAttachment,
  PlaneIssueLink,
  PlaneComment,
  PlaneLabel,
  PlaneMember,
  PlaneProject,
  PlaneState,
  PlaneWorkItem
} from '../../shared/plane/types'

type PlaneClient = PlaneClientForInstance

export function mapProject(client: PlaneClient, input: unknown): PlaneProject | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  if (!id || !name) {
    return null
  }
  const identifier = stringField(raw, 'identifier')
  return {
    id,
    name,
    description: stringField(raw, 'description') ?? stringField(raw, 'description_stripped'),
    identifier,
    workspaceSlug: client.instance.workspaceSlug,
    instanceId: client.instance.id,
    url: `${client.instance.baseUrl}/${client.instance.workspaceSlug}/projects/${identifier ?? id}`,
    cycleView: booleanField(raw, 'cycle_view'),
    moduleView: booleanField(raw, 'module_view'),
    inboxView: booleanField(raw, 'inbox_view'),
    pageView: booleanField(raw, 'page_view'),
    issueViewsView: booleanField(raw, 'issue_views_view'),
    totalCycles: numberField(raw, 'total_cycles'),
    totalModules: numberField(raw, 'total_modules')
  }
}

export function mapWorkItem(
  client: PlaneClient,
  project: PlaneProject | null,
  input: unknown
): PlaneWorkItem | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const title = stringField(raw, 'name') ?? stringField(raw, 'title')
  if (!id || !title) {
    return null
  }
  const projectRecord = recordOrNull(raw.project) ?? recordOrNull(raw.project_detail) ?? {}
  const projectId =
    project?.id ?? stringField(raw, 'project_id') ?? stringField(projectRecord, 'id') ?? ''
  const projectIdentifier =
    project?.identifier ??
    stringField(raw, 'project_identifier') ??
    stringField(projectRecord, 'identifier')
  const sequenceId = numberField(raw, 'sequence_id') ?? numberField(raw, 'sequence')
  const identifier =
    stringField(raw, 'identifier') ??
    (projectIdentifier && sequenceId ? `${projectIdentifier}-${sequenceId}` : id)
  const assigneeIds = idArray(raw.assignees)
  const labelIds = idArray(raw.labels)
  return {
    id,
    identifier,
    sequenceId,
    title,
    description: stringField(raw, 'description_html') ?? stringField(raw, 'description_stripped'),
    url: planeWebUrl(client, identifier),
    project: {
      id: projectId,
      name: project?.name ?? stringField(projectRecord, 'name') ?? projectIdentifier ?? projectId,
      identifier: projectIdentifier
    },
    state: mapState(raw.state ?? raw.state_detail),
    assignee: Array.isArray(raw.assignees) ? mapMember(raw.assignees[0]) : mapMember(raw.assignee),
    assignees: Array.isArray(raw.assignees) ? raw.assignees.map(mapMember).filter(notNull) : [],
    assigneeIds: assigneeIds.length > 0 ? assigneeIds : idArray(raw.assignee_ids),
    createdBy: mapMember(raw.created_by ?? raw.created_by_detail ?? raw.created_by_member),
    createdById: idValue(raw.created_by ?? raw.created_by_detail ?? raw.created_by_member),
    labels: Array.isArray(raw.labels) ? raw.labels.map(mapLabel).filter(notNull) : [],
    labelIds: labelIds.length > 0 ? labelIds : idArray(raw.label_ids),
    priority: stringField(raw, 'priority'),
    cycleId: idValue(raw.cycle) ?? idValue(raw.cycle_id),
    estimatePoint: estimatePointValue(raw.estimate_point),
    typeId: idValue(raw.type) ?? idValue(raw.type_id),
    moduleId: idValue(raw.module) ?? firstIdValue(raw.module_ids),
    updatedAt: stringField(raw, 'updated_at'),
    createdAt: stringField(raw, 'created_at'),
    workspaceSlug: client.instance.workspaceSlug,
    instanceId: client.instance.id
  }
}

export function mapState(input: unknown): PlaneState | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? { id, name, group: stringField(raw, 'group'), color: stringField(raw, 'color') }
    : null
}

export function mapLabel(input: unknown): PlaneLabel | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name ? { id, name, color: stringField(raw, 'color') } : null
}

export function mapMember(input: unknown): PlaneMember | null {
  const raw = record(input)
  const id = stringField(raw, 'id') ?? stringField(raw, 'member_id')
  const displayName =
    stringField(raw, 'display_name') ?? stringField(raw, 'first_name') ?? stringField(raw, 'email')
  return id && displayName ? { id, displayName, email: stringField(raw, 'email') } : null
}

export function mapComment(input: unknown): PlaneComment | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const body = stringField(raw, 'comment_html') ?? stringField(raw, 'comment_stripped')
  return id && body
    ? {
        id,
        body,
        createdAt: stringField(raw, 'created_at'),
        author: mapMember(raw.actor ?? raw.created_by)
      }
    : null
}

export function mapIssueLink(input: unknown): PlaneIssueLink | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const url = stringField(raw, 'url')
  return id && url
    ? {
        id,
        url,
        title: stringField(raw, 'title'),
        metadata: recordOrNull(raw.metadata)
      }
    : null
}

export function mapIssueAttachment(input: unknown): PlaneIssueAttachment | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  if (!id) {
    return null
  }
  return {
    id,
    name: stringField(raw, 'name') ?? stringField(raw, 'file_name'),
    url: stringField(raw, 'url') ?? stringField(raw, 'asset'),
    size: numberField(raw, 'size'),
    mimeType: stringField(raw, 'mime_type') ?? stringField(raw, 'content_type'),
    createdAt: stringField(raw, 'created_at')
  }
}

export function arrayFromResponse(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input
  }
  const raw = record(input)
  if (Array.isArray(raw.results)) {
    return raw.results
  }
  if (Array.isArray(raw.items)) {
    return raw.items
  }
  if (Array.isArray(raw.issues)) {
    return raw.issues
  }
  return []
}

export function notNull<T>(value: T | null): value is T {
  return value !== null
}

export function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function recordOrNull(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

export function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function numberField(input: Record<string, unknown>, key: string): number | null {
  const value = input[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function booleanField(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key]
  return typeof value === 'boolean' ? value : null
}

function idValue(input: unknown): string | null {
  if (typeof input === 'string' && input.trim()) {
    return input.trim()
  }
  return stringField(record(input), 'id')
}

function idArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .map((item) => (typeof item === 'string' ? item : stringField(record(item), 'id')))
    .filter((item): item is string => Boolean(item))
}

function firstIdValue(input: unknown): string | null {
  return idArray(input)[0] ?? null
}

function estimatePointValue(input: unknown): string | number | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input
  }
  if (typeof input === 'string' && input.trim()) {
    return input.trim()
  }
  return null
}
