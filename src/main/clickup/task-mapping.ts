import type { ClickUpPriority, ClickUpStatus, ClickUpTag, ClickUpTask, ClickUpUser } from '../../shared/clickup-types'
import { getStatus, type ClickUpClientForWorkspace } from './client'

export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' ? (value as JsonRecord) : null
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' ? String(value) : undefined
}

export function timestampToIso(value: unknown): string | undefined {
  const timestamp =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function dueDateToTimestamp(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp)) {
    throw new Error('Due date must use YYYY-MM-DD.')
  }
  return timestamp
}

export function normalizeClickUpUser(value: unknown): ClickUpUser | null {
  const record = asRecord(value)
  const id =
    typeof record?.id === 'number'
      ? record.id
      : typeof record?.id === 'string'
        ? Number(record.id)
        : Number.NaN
  if (!record || !Number.isFinite(id)) {
    return null
  }
  const username =
    typeof record.username === 'string'
      ? record.username
      : typeof record.name === 'string'
        ? record.name
        : String(id)
  return {
    id,
    username,
    email: typeof record.email === 'string' ? record.email : undefined,
    color: typeof record.color === 'string' ? record.color : undefined,
    profilePicture: typeof record.profilePicture === 'string' ? record.profilePicture : undefined
  }
}

export function normalizeClickUpStatus(value: unknown): ClickUpStatus {
  const record = asRecord(value)
  return {
    name: asString(record?.status) ?? asString(record?.name) ?? 'Unknown',
    color: asString(record?.color) ?? '#87909e',
    type: asString(record?.type) ?? 'custom',
    orderIndex: Number(asString(record?.orderindex) ?? asString(record?.orderIndex) ?? 0)
  }
}

function normalizeClickUpPriority(value: unknown): ClickUpPriority | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const id = Number(record.id)
  if (!Number.isFinite(id)) {
    return null
  }
  return {
    id,
    name: asString(record.priority) ?? asString(record.name) ?? String(id),
    color: asString(record.color) ?? '#87909e',
    orderIndex: Number(asString(record.orderindex) ?? asString(record.orderIndex) ?? id)
  }
}

export function normalizeClickUpTag(value: unknown): ClickUpTag | null {
  const record = asRecord(value)
  if (!record || typeof record.name !== 'string') {
    return null
  }
  return {
    name: record.name,
    tagFg: typeof record.tag_fg === 'string' ? record.tag_fg : undefined,
    tagBg: typeof record.tag_bg === 'string' ? record.tag_bg : undefined
  }
}

export function normalizeClickUpLocation(value: unknown): { id: string; name: string } | undefined {
  const record = asRecord(value)
  const id = asString(record?.id)
  return id ? { id, name: asString(record?.name) ?? id } : undefined
}

function taskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${encodeURIComponent(taskId)}`
}

export function normalizeClickUpTask(
  value: unknown,
  client: ClickUpClientForWorkspace
): ClickUpTask | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  const list = normalizeClickUpLocation(record?.list)
  if (!record || !id || !name || !list) {
    return null
  }
  const subtasks = Array.isArray(record.subtasks)
    ? record.subtasks.flatMap((subtask) => {
        const child = asRecord(subtask)
        const childId = asString(child?.id)
        const childName = asString(child?.name)
        return childId && childName
          ? [
              {
                id: childId,
                customId: asString(child?.custom_id) ?? null,
                name: childName,
                url: asString(child?.url) ?? taskUrl(childId)
              }
            ]
          : []
      })
    : undefined
  const responseWorkspaceId =
    asString(record.team_id) ?? asString(asRecord(record.team)?.id) ?? client.workspace.id
  // Why: task reads are token-scoped, so an "all" selection can return a task
  // through the first client even when another Workspace owns it.
  const workspace =
    getStatus().workspaces?.find((item) => item.id === responseWorkspaceId) ?? client.workspace
  return {
    id,
    customId: asString(record.custom_id) ?? null,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    name,
    description:
      asString(record.markdown_description) ??
      asString(record.description) ??
      asString(record.text_content),
    url: asString(record.url) ?? taskUrl(id),
    status: normalizeClickUpStatus(record.status),
    priority: normalizeClickUpPriority(record.priority),
    assignees: Array.isArray(record.assignees)
      ? record.assignees
          .map(normalizeClickUpUser)
          .filter((user): user is ClickUpUser => user !== null)
      : [],
    creator: normalizeClickUpUser(record.creator) ?? undefined,
    tags: Array.isArray(record.tags)
      ? record.tags.map(normalizeClickUpTag).filter((tag): tag is ClickUpTag => tag !== null)
      : [],
    list,
    folder: normalizeClickUpLocation(record.folder),
    space: normalizeClickUpLocation(record.space),
    parent: asString(record.parent) ?? null,
    subtasks,
    dueDate: timestampToIso(record.due_date) ?? null,
    startDate: timestampToIso(record.start_date) ?? null,
    timeEstimate:
      typeof record.time_estimate === 'number'
        ? record.time_estimate
        : typeof record.time_estimate === 'string'
          ? Number(record.time_estimate)
          : null,
    points: typeof record.points === 'number' ? record.points : null,
    createdAt: timestampToIso(record.date_created) ?? new Date(0).toISOString(),
    updatedAt: timestampToIso(record.date_updated) ?? new Date(0).toISOString(),
    closedAt: timestampToIso(record.date_closed) ?? null
  }
}
