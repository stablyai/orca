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

export type RawKanbanPerson = {
  id: string
  name: string
}

export type RawKanbanLane = {
  id: string
  name: string
}

export type RawKanbanComment = {
  id: string
  author?: RawKanbanPerson | null
  text: string
  created_at: string
}

export type RawKanbanAttachment = {
  name: string
  url: string
  size?: number | null
}

export type RawKanbanSubtask = {
  id: string
  title: string
  done: boolean
}

export type RawKanbanTask = {
  id: string
  t: string
  lane: string | RawKanbanLane
  created_by?: RawKanbanPerson | null
  executors?: RawKanbanPerson[]
  observers?: RawKanbanPerson[]
  due?: string | null
  hot?: boolean
  task_version: number
  result?: string
  d?: string
  tag?: string[]
  src?: string | null
  gh?: string | null
  repo?: string | string[]
  blocked_by?: string[]
  attachments?: RawKanbanAttachment[]
  subtasks?: RawKanbanSubtask[]
  c?: RawKanbanComment[]
}

export type RawKanbanViewer = {
  id: string
  name: string
  level: string
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

export function mapNullablePerson(raw: unknown): KanbanPerson | null | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return null
  }
  return mapPerson(raw) ?? BROKEN
}

export function mapPersonList(raw: unknown): KanbanPerson[] | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    return BROKEN
  }
  const persons: KanbanPerson[] = []
  for (const item of raw) {
    const person = mapPerson(item)
    if (!person) {
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
  return typeof raw === 'string' ? raw : BROKEN
}

export function readOptionalBoolean(raw: unknown): boolean | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return false
  }
  return typeof raw === 'boolean' ? raw : BROKEN
}

export function readStringList(raw: unknown): string[] | typeof BROKEN {
  if (raw === undefined || raw === null) {
    return []
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
      urls.push(repo)
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
    urls.push(gh)
  }
  return urls
}

export function mapLaneObject(raw: unknown): KanbanLane | null {
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

export function mapComment(raw: unknown): KanbanComment | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const text = typeof raw.text === 'string' ? raw.text : null
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : null
  if (!id || !text || !createdAt) {
    return null
  }
  const author = mapNullablePerson(raw.author)
  if (author === BROKEN) {
    return null
  }
  return { id, author, text, createdAt }
}

export function mapAttachment(raw: unknown): KanbanAttachment | null {
  if (!isRecord(raw)) {
    return null
  }
  const name = nonEmptyString(raw.name)
  const url = nonEmptyString(raw.url)
  if (!name || !url) {
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
  return { name, url, size }
}

export function mapSubtask(raw: unknown): KanbanSubtask | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const title = nonEmptyString(raw.title)
  if (!id || !title) {
    return null
  }
  // Why: `done` is required; a missing or non-boolean value must not be
  // silently coerced to false.
  if (typeof raw.done !== 'boolean') {
    return null
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
