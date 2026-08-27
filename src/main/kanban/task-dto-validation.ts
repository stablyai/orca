import { createHash } from 'node:crypto'
import { KANBAN_SERVER_URL } from '../../shared/kanban-types'
import type {
  KanbanAttachment,
  KanbanComment,
  KanbanLane,
  KanbanPerson,
  KanbanSubtask
} from '../../shared/kanban-types'

export type KanbanMapperResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid_response' }

export type KanbanMappingContext = {
  lanesById: Map<string, KanbanLane>
  usersById: Map<string, KanbanPerson>
}

export const BROKEN = Symbol('broken')

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return value.trim().length > 0 ? value : null
}

export function mapPerson(raw: unknown): KanbanPerson | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const name = nonEmptyString(raw.name)
  if (!id || !name) {
    return null
  }
  return { id, name }
}

export function mapNullablePerson(
  raw: unknown,
  usersById: ReadonlyMap<string, KanbanPerson> = new Map(),
  fallbackToId = false
): KanbanPerson | null | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return null
  }
  if (typeof raw === 'string') {
    const id = nonEmptyString(raw)
    if (!id) {
      return BROKEN
    }
    return usersById.get(id) ?? (fallbackToId ? { id, name: id } : BROKEN)
  }
  return mapPerson(raw) ?? BROKEN
}

export function mapPersonList(
  raw: unknown,
  usersById: ReadonlyMap<string, KanbanPerson> = new Map()
): KanbanPerson[] | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    return BROKEN
  }
  const persons: KanbanPerson[] = []
  for (const item of raw) {
    const person = typeof item === 'string' ? usersById.get(item) : mapPerson(item)
    if (person === undefined || person === null) {
      return BROKEN
    }
    persons.push(person)
  }
  return persons
}

export function readNullableString(raw: unknown): string | null | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return null
  }
  return typeof raw === 'string' ? raw || null : BROKEN
}

export function readOptionalBoolean(raw: unknown): boolean | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return false
  }
  if (typeof raw === 'boolean') {
    return raw
  }
  return raw === 0 ? false : raw === 1 ? true : BROKEN
}

export function readStringList(raw: unknown): string[] | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return []
  }
  if (typeof raw === 'string') {
    return raw ? [raw] : []
  }
  if (!Array.isArray(raw)) {
    return BROKEN
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      return BROKEN
    }
  }
  return raw as string[]
}

export function readRepositoryUrls(repo: unknown, gh: unknown): string[] | typeof BROKEN {
  const urls: string[] = []
  if (repo !== undefined && repo !== null) {
    if (typeof repo === 'string') {
      if (repo) {
        urls.push(repo)
      }
    } else if (Array.isArray(repo)) {
      for (const item of repo) {
        if (typeof item !== 'string') {
          return BROKEN
        }
      }
      urls.push(...repo)
    } else {
      return BROKEN
    }
  }
  if (gh !== undefined && gh !== null) {
    if (typeof gh !== 'string') {
      return BROKEN
    }
    if (gh) {
      urls.push(gh)
    }
  }
  return urls
}

export function mapLaneObject(raw: unknown): KanbanLane | null {
  if (typeof raw === 'string' && raw.length > 0) {
    return { id: raw, name: raw }
  }
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const name = nonEmptyString(raw.name)
  if (!id || !name) {
    return null
  }
  return { id, name }
}

export function mapLane(raw: unknown, lanesById: Map<string, KanbanLane>): KanbanLane | null {
  if (typeof raw === 'string') {
    return lanesById.get(raw) ?? null
  }
  return mapLaneObject(raw)
}

export function mapComment(
  raw: unknown,
  usersById: ReadonlyMap<string, KanbanPerson> = new Map()
): KanbanComment | null {
  if (!isRecord(raw)) {
    return null
  }
  if ('ts' in raw || 'author_id' in raw || 'm' in raw || 'a' in raw || 'channel' in raw) {
    const createdAt = nonEmptyString(raw.ts)
    const authorId = typeof raw.author_id === 'string' ? raw.author_id : null
    const authorName = nonEmptyString(raw.a)
    if (
      !createdAt ||
      authorId === null ||
      !authorName ||
      typeof raw.m !== 'string' ||
      typeof raw.channel !== 'string'
    ) {
      return null
    }
    const author = authorId
      ? (usersById.get(authorId) ?? { id: authorId, name: authorName })
      : {
          id: `comment-author-${createHash('sha256').update(authorName).digest('hex').slice(0, 16)}`,
          name: authorName
        }
    const digest = createHash('sha256')
      .update(JSON.stringify([raw.ts, raw.author_id, raw.a, raw.m, raw.channel]))
      .digest('hex')
      .slice(0, 16)
    return {
      id: nonEmptyString(raw.id) ?? `comment-${digest}`,
      author,
      text: raw.m,
      createdAt
    }
  }
  const id = nonEmptyString(raw.id)
  const text = typeof raw.text === 'string' ? raw.text : null
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : null
  if (!id || text === null || !createdAt) {
    return null
  }
  const author = mapNullablePerson(raw.author)
  if (author === BROKEN) {
    return null
  }
  return { id, author, text, createdAt }
}

export function mapAttachment(raw: unknown, taskId?: string): KanbanAttachment | null {
  if (!isRecord(raw)) {
    return null
  }
  const name = nonEmptyString(raw.name)
  const attachmentId = nonEmptyString(raw.id)
  const suppliedUrl = nonEmptyString(raw.url)
  if (!name || (!suppliedUrl && (!attachmentId || !taskId))) {
    return null
  }
  if (attachmentId && taskId && typeof raw.mime !== 'string') {
    return null
  }
  // Why: a present-but-malformed size must not be silently cast to null; only
  // an absent size (or an explicit null) is acceptable.
  if (
    raw.size !== undefined &&
    raw.size !== null &&
    (typeof raw.size !== 'number' || !Number.isFinite(raw.size))
  ) {
    return null
  }
  const size = raw.size === undefined || raw.size === null ? null : raw.size
  const url =
    attachmentId && taskId
      ? `${KANBAN_SERVER_URL}/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`
      : suppliedUrl!
  return { name, url, size }
}

export function mapSubtask(
  raw: unknown,
  usersById: ReadonlyMap<string, KanbanPerson> = new Map()
): KanbanSubtask | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const title = nonEmptyString(raw.t) ?? nonEmptyString(raw.title)
  if (!id || !title) {
    return null
  }
  // Why: `done` is required; a missing or non-boolean value must not be
  // silently coerced to false.
  if (typeof raw.done !== 'boolean') {
    return null
  }
  if ('executor_id' in raw) {
    const executorId = raw.executor_id
    if (typeof executorId !== 'string' || (executorId !== '' && !usersById.has(executorId))) {
      return null
    }
  }
  return { id, title, done: raw.done }
}

export function mapList<T>(raw: unknown, mapper: (item: unknown) => T | null): T[] | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    return BROKEN
  }
  const out: T[] = []
  for (const item of raw) {
    const mapped = mapper(item)
    if (mapped === null) {
      return BROKEN
    }
    out.push(mapped)
  }
  return out
}
