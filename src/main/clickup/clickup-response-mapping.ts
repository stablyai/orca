import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type {
  ClickUpComment,
  ClickUpPriority,
  ClickUpStatusOption,
  ClickUpStatusType,
  ClickUpTask,
  ClickUpUser,
  ClickUpViewer,
  ClickUpWorkspace
} from '../../shared/clickup/clickup-types'

type RawRecord = Record<string, unknown>

const STATUS_TYPES: readonly ClickUpStatusType[] = ['open', 'custom', 'done', 'closed']
const DEFAULT_STATUS_COLOR = '#87909e'
const EPOCH_ISO = new Date(0).toISOString()

function asRecord(value: unknown): RawRecord | null {
  return isRecord(value) ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

// ClickUp serializes ids as numbers in some payloads and strings in others.
function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return nonEmptyString(value)
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

function millisecondsToIso(value: unknown): string | null {
  const ms = asNumber(value)
  if (ms === null) {
    return null
  }
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function mapClickUpUser(value: unknown): ClickUpUser | null {
  const raw = asRecord(value)
  const id = asId(raw?.id)
  if (!raw || !id) {
    return null
  }
  const avatarUrl = nonEmptyString(raw.profilePicture) ?? nonEmptyString(raw.profile_picture)
  return {
    id,
    username: typeof raw.username === 'string' ? raw.username : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

/** Maps the `GET /user` payload. */
export function mapClickUpViewer(payload: unknown): ClickUpViewer | null {
  return mapClickUpUser(asRecord(payload)?.user)
}

/** Maps the `GET /team` payload; entries without an id or name are dropped. */
export function mapClickUpWorkspaces(payload: unknown): ClickUpWorkspace[] {
  return asArray(asRecord(payload)?.teams).flatMap((entry) => {
    const raw = asRecord(entry)
    const id = asId(raw?.id)
    const name = nonEmptyString(raw?.name)
    if (!raw || !id || !name) {
      return []
    }
    const color = nonEmptyString(raw.color)
    return [{ id, name, ...(color ? { color } : {}) }]
  })
}

export function mapClickUpStatus(value: unknown): ClickUpStatusOption | null {
  const raw = asRecord(value)
  const name = typeof raw?.status === 'string' ? raw.status : null
  if (!raw || name === null) {
    return null
  }
  const type = STATUS_TYPES.find((candidate) => candidate === raw.type)
  return {
    name,
    color: nonEmptyString(raw.color) ?? DEFAULT_STATUS_COLOR,
    type: type ?? 'custom',
    orderIndex: asNumber(raw.orderindex) ?? 0
  }
}

/** Maps the `GET /list/{id}` payload into the statuses a task in that list can move to. */
export function mapClickUpListStatuses(payload: unknown): ClickUpStatusOption[] {
  return asArray(asRecord(payload)?.statuses)
    .flatMap((entry) => mapClickUpStatus(entry) ?? [])
    .sort((a, b) => a.orderIndex - b.orderIndex)
}

function mapPriority(value: unknown): ClickUpPriority | null {
  const raw = asRecord(value)
  const id = asId(raw?.id)
  const label = nonEmptyString(raw?.priority)
  if (!raw || !id || !label) {
    return null
  }
  return { id, label, color: nonEmptyString(raw.color) ?? DEFAULT_STATUS_COLOR }
}

function mapNamedEntity(value: unknown): { id: string; name: string } | null {
  const raw = asRecord(value)
  const id = asId(raw?.id)
  if (!raw || !id) {
    return null
  }
  return { id, name: typeof raw.name === 'string' ? raw.name : '' }
}

/** Maps one task; returns null when the payload has no usable id. */
export function mapClickUpTask(value: unknown, fallbackWorkspaceId: string): ClickUpTask | null {
  const raw = asRecord(value)
  const id = asId(raw?.id)
  if (!raw || !id) {
    return null
  }
  const folder = asRecord(raw.folder)
  const createdAt =
    millisecondsToIso(raw.date_created) ?? millisecondsToIso(raw.date_updated) ?? EPOCH_ISO
  return {
    id,
    customId: nonEmptyString(raw.custom_id),
    name: typeof raw.name === 'string' ? raw.name : '',
    descriptionMarkdown:
      nonEmptyString(raw.markdown_description) ??
      nonEmptyString(raw.description) ??
      nonEmptyString(raw.text_content) ??
      '',
    status: mapClickUpStatus(raw.status) ?? {
      name: '',
      color: DEFAULT_STATUS_COLOR,
      type: 'custom',
      orderIndex: 0
    },
    priority: mapPriority(raw.priority),
    assignees: asArray(raw.assignees).flatMap((assignee) => mapClickUpUser(assignee) ?? []),
    creator: mapClickUpUser(raw.creator),
    tags: asArray(raw.tags).flatMap((tag) => nonEmptyString(asRecord(tag)?.name) ?? []),
    url: nonEmptyString(raw.url) ?? `https://app.clickup.com/t/${encodeURIComponent(id)}`,
    createdAt,
    updatedAt: millisecondsToIso(raw.date_updated) ?? createdAt,
    dueAt: millisecondsToIso(raw.due_date),
    list: mapNamedEntity(raw.list) ?? { id: '', name: '' },
    // A list that sits directly in a Space reports a placeholder hidden folder.
    folder: folder?.hidden === true ? null : mapNamedEntity(folder),
    spaceId: asId(asRecord(raw.space)?.id) ?? '',
    workspaceId: asId(raw.team_id) ?? fallbackWorkspaceId,
    parentId: asId(raw.parent)
  }
}

export function mapClickUpTasks(payload: unknown, fallbackWorkspaceId: string): ClickUpTask[] {
  return asArray(asRecord(payload)?.tasks).flatMap(
    (entry) => mapClickUpTask(entry, fallbackWorkspaceId) ?? []
  )
}

function commentText(raw: RawRecord): string {
  const plain = nonEmptyString(raw.comment_text)
  if (plain) {
    return plain
  }
  // Rich comments carry their text in structured blocks when the flat field is absent.
  return asArray(raw.comment)
    .map((block) => asRecord(block)?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

export function mapClickUpComment(value: unknown): ClickUpComment | null {
  const raw = asRecord(value)
  const id = asId(raw?.id)
  if (!raw || !id) {
    return null
  }
  return {
    id,
    body: commentText(raw),
    createdAt: millisecondsToIso(raw.date) ?? EPOCH_ISO,
    author: mapClickUpUser(raw.user)
  }
}

export function mapClickUpComments(payload: unknown): ClickUpComment[] {
  return asArray(asRecord(payload)?.comments).flatMap((entry) => mapClickUpComment(entry) ?? [])
}
