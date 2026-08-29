import type {
  VoloBoard,
  VoloColumn,
  VoloMember,
  VoloPriority,
  VoloTask,
  VoloViewer
} from '../../shared/volo-types'
import { isVoloPriority } from '../../shared/volo-types'
import { voloTaskWebUrl } from '../../shared/volo-urls'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asIso(value: unknown, fallback: string): string {
  const text = asString(value)
  if (text) {
    return text
  }
  return fallback
}

export function mapVoloViewer(value: unknown, fallbackName: string): VoloViewer {
  const record = asRecord(value)
  return {
    id: asString(record?.id) ?? 'volo-user',
    displayName: asString(record?.name) ?? asString(record?.displayName) ?? fallbackName,
    email: asString(record?.email),
    ...(asString(record?.avatar) || asString(record?.avatarUrl)
      ? { avatarUrl: asString(record?.avatar) ?? asString(record?.avatarUrl) ?? undefined }
      : {})
  }
}

function mapColumn(value: unknown, index: number): VoloColumn | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  if (!id || !name) {
    return null
  }
  return {
    id,
    name,
    order: asNumber(record?.order, index),
    color: asString(record?.color) ?? undefined,
    type: asString(record?.type) ?? 'not_started'
  }
}

export function mapVoloBoard(value: unknown): VoloBoard | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  const prefix = asString(record?.prefix)
  if (!record || !id || !name || !prefix) {
    return null
  }
  const columns = Array.isArray(record.columns)
    ? record.columns
        .map((column, index) => mapColumn(column, index))
        .filter((column): column is VoloColumn => column !== null)
        .sort((a, b) => a.order - b.order)
    : []
  return {
    id,
    name,
    prefix,
    description: asString(record.description) ?? undefined,
    icon: asString(record.icon) ?? undefined,
    columns
  }
}

export function mapVoloMember(value: unknown): VoloMember | null {
  const record = asRecord(value)
  const nestedUser = asRecord(record?.user)
  const id = asString(record?.id)
  const userId = asString(record?.userId) ?? asString(nestedUser?.id)
  const name =
    asString(record?.name) ?? asString(nestedUser?.name) ?? asString(nestedUser?.displayName)
  if (!id || !userId || !name) {
    return null
  }
  return {
    id,
    userId,
    name,
    email: asString(record?.email) ?? asString(nestedUser?.email),
    avatarUrl:
      asString(record?.avatar) ??
      asString(record?.avatarUrl) ??
      asString(nestedUser?.avatar) ??
      asString(nestedUser?.avatarUrl) ??
      undefined
  }
}

function resolveAssignee(
  assigneeId: string | null,
  membersById: ReadonlyMap<string, VoloMember>
): VoloMember | undefined {
  if (!assigneeId) {
    return undefined
  }
  return (
    membersById.get(assigneeId) ??
    [...membersById.values()].find((member) => member.userId === assigneeId)
  )
}

export function mapVoloTask(
  value: unknown,
  board: Pick<VoloBoard, 'id' | 'name' | 'prefix' | 'columns'>,
  webUrl: string,
  membersById: ReadonlyMap<string, VoloMember>
): VoloTask | null {
  const record = asRecord(value)
  const id = asString(record?.id) ?? asString(record?.taskId)
  const taskCode = asString(record?.taskCode)
  const title = asString(record?.title)
  const columnId = asString(record?.columnId)
  if (!id || !taskCode || !title || !columnId) {
    return null
  }
  const column = board.columns.find((entry) => entry.id === columnId)
  const assigneeId = asString(record?.assignee)
  const assignee = resolveAssignee(assigneeId, membersById)
  const priority: VoloPriority = isVoloPriority(record?.priority) ? record.priority : 'medium'
  const createdAt = asIso(record?.createdAt, new Date(0).toISOString())
  const updatedAt = asIso(record?.updatedAt, createdAt)
  return {
    id,
    taskCode,
    title,
    description: asString(record?.description) ?? undefined,
    url: voloTaskWebUrl(webUrl, taskCode),
    boardId: asString(record?.boardId) ?? board.id,
    boardName: asString(record?.boardName) ?? board.name,
    boardPrefix: asString(record?.boardPrefix) ?? board.prefix,
    columnId,
    columnName: asString(record?.columnName) ?? column?.name,
    columnType: asString(record?.columnType) ?? column?.type,
    columnColor: column?.color,
    priority,
    assigneeId,
    assigneeName: assignee?.name ?? null,
    inKanban: record?.inKanban === true,
    dueDate: asString(record?.dueDate),
    order: asNumber(record?.order, asNumber(record?.ageDays)),
    updatedAt,
    createdAt
  }
}

export function flattenCrossBoardKanban(value: unknown, webUrl: string): VoloTask[] {
  const record = asRecord(value)
  const columns = Array.isArray(record?.columns) ? record.columns : []
  const tasks: VoloTask[] = []
  for (const column of columns) {
    const columnRecord = asRecord(column)
    const rows = Array.isArray(columnRecord?.tasks) ? columnRecord.tasks : []
    for (const row of rows) {
      const taskRecord = asRecord(row)
      const board = {
        id: asString(taskRecord?.boardId) ?? '',
        name: asString(taskRecord?.boardName) ?? '',
        prefix: asString(taskRecord?.boardPrefix) ?? '',
        columns: []
      }
      const task = mapVoloTask(row, board, webUrl, new Map())
      if (task) {
        tasks.push(task)
      }
    }
  }
  return tasks
}
