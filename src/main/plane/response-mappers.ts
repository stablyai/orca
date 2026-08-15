import { planeWebUrl, type PlaneClientForInstance } from './client'
import type {
  PlaneCycle,
  PlaneEstimate,
  PlaneEstimatePoint,
  PlaneIssueAttachment,
  PlaneIssueLink,
  PlaneComment,
  PlaneLabel,
  PlaneMember,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneWorkItemType,
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
  const projectRecord = record(raw.project) || record(raw.project_detail)
  const projectId = project?.id ?? stringField(raw, 'project_id') ?? stringField(projectRecord, 'id') ?? ''
  const projectIdentifier = project?.identifier ?? stringField(raw, 'project_identifier') ?? stringField(projectRecord, 'identifier')
  const sequenceId = numberField(raw, 'sequence_id') ?? numberField(raw, 'sequence')
  const identifier = stringField(raw, 'identifier') ?? (projectIdentifier && sequenceId ? `${projectIdentifier}-${sequenceId}` : id)
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
    assigneeIds: idArray(raw.assignees),
    createdBy: mapMember(raw.created_by ?? raw.created_by_detail ?? raw.created_by_member),
    createdById: idValue(raw.created_by ?? raw.created_by_detail ?? raw.created_by_member),
    labels: Array.isArray(raw.labels) ? raw.labels.map(mapLabel).filter(notNull) : [],
    labelIds: idArray(raw.labels),
    priority: stringField(raw, 'priority'),
    cycleId: idValue(raw.cycle),
    estimatePoint: estimatePointValue(raw.estimate_point),
    typeId: idValue(raw.type),
    moduleId: idValue(raw.module),
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
  return id && name ? { id, name, group: stringField(raw, 'group'), color: stringField(raw, 'color') } : null
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
  const displayName = stringField(raw, 'display_name') ?? stringField(raw, 'first_name') ?? stringField(raw, 'email')
  return id && displayName ? { id, displayName, email: stringField(raw, 'email') } : null
}

export function mapComment(input: unknown): PlaneComment | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const body = stringField(raw, 'comment_html') ?? stringField(raw, 'comment_stripped')
  return id && body ? { id, body, createdAt: stringField(raw, 'created_at'), author: mapMember(raw.actor ?? raw.created_by) } : null
}

export function mapCycle(client: PlaneClient, projectId: string, input: unknown): PlaneCycle | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        startDate: stringField(raw, 'start_date'),
        endDate: stringField(raw, 'end_date'),
        status: stringField(raw, 'status'),
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapModule(client: PlaneClient, projectId: string, input: unknown): PlaneModule | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        startDate: stringField(raw, 'start_date'),
        targetDate: stringField(raw, 'target_date'),
        status: stringField(raw, 'status'),
        lead: mapMember(raw.lead ?? raw.module_lead),
        members: Array.isArray(raw.members) ? raw.members.map(mapMember).filter(notNull) : [],
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapWorkItemType(
  client: PlaneClient,
  projectId: string,
  input: unknown
): PlaneWorkItemType | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        isDefault: booleanField(raw, 'is_default'),
        isActive: booleanField(raw, 'is_active'),
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapEstimate(client: PlaneClient, projectId: string, input: unknown): PlaneEstimate | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        points: Array.isArray(raw.points)
          ? raw.points.map(mapEstimatePoint).filter(notNull)
          : undefined,
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapEstimatePoint(input: unknown): PlaneEstimatePoint | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  return id
    ? {
        id,
        key: stringField(raw, 'key'),
        value: stringField(raw, 'value') ?? numberField(raw, 'value'),
        description: stringField(raw, 'description')
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

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function recordOrNull(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberField(input: Record<string, unknown>, key: string): number | null {
  const value = input[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanField(input: Record<string, unknown>, key: string): boolean | null {
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

function estimatePointValue(input: unknown): string | number | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input
  }
  if (typeof input === 'string' && input.trim()) {
    return input.trim()
  }
  return null
}
