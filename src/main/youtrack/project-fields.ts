import type {
  YouTrackFieldKind,
  YouTrackFieldOption,
  YouTrackFieldSchema,
  YouTrackProjectSummary
} from '../../shared/youtrack-types'
import {
  activeBundleValues,
  isRawRecord,
  rawRecords as records,
  type RawRecord
} from './raw-record'
import { youtrackRequest, type YouTrackCredentials } from './youtrack-request'

const CACHE_TTL_MS = 5 * 60_000

const PROJECT_FIELDS =
  '$type,canBeEmpty,emptyFieldText,field(name,fieldType(id,isMultiValue)),' +
  'bundle(values(name,archived,ordinal,login,fullName,banned),aggregatedUsers(login,fullName,banned)),' +
  'defaultValues(name,login)'

const KIND_BY_PREFIX: Record<string, YouTrackFieldKind> = {
  enum: 'enum',
  user: 'user',
  version: 'version',
  build: 'build',
  ownedField: 'owned',
  state: 'state',
  string: 'string',
  integer: 'integer',
  float: 'float',
  date: 'date',
  'date and time': 'datetime',
  period: 'period',
  text: 'text'
}

type CacheEntry<T> = { at: number; value: T }
const fieldsCache = new Map<string, CacheEntry<YouTrackFieldSchema[]>>()
let projectsCache: CacheEntry<YouTrackProjectSummary[]> | null = null

function fresh<T>(entry: CacheEntry<T> | null | undefined): T | null {
  return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry.value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function toFieldKind(fieldTypeId: string): YouTrackFieldKind {
  return KIND_BY_PREFIX[fieldTypeId.replace(/\[.*\]$/, '')] ?? 'unknown'
}

function toOptions(kind: YouTrackFieldKind, bundle: unknown): YouTrackFieldOption[] {
  if (!isRawRecord(bundle)) {
    return []
  }
  if (kind === 'user') {
    return records(bundle.aggregatedUsers)
      .filter((user) => user.banned !== true && text(user.login))
      .map((user) => ({
        value: String(user.login),
        label: text(user.fullName) ?? String(user.login)
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }
  return activeBundleValues(bundle).map((value) => ({
    value: String(value.name),
    label: String(value.name)
  }))
}

export function toFieldSchema(raw: RawRecord): YouTrackFieldSchema | null {
  const field = isRawRecord(raw.field) ? raw.field : null
  const fieldType = isRawRecord(field?.fieldType) ? field.fieldType : null
  const name = text(field?.name)
  const typeId = text(fieldType?.id)
  if (!name || !typeId) {
    return null
  }
  const kind = toFieldKind(typeId)
  return {
    name,
    kind,
    multi: fieldType?.isMultiValue === true || typeId.endsWith('[*]'),
    required: raw.canBeEmpty === false,
    emptyText: text(raw.emptyFieldText),
    options: toOptions(kind, raw.bundle),
    defaults: records(raw.defaultValues).flatMap((value) => {
      const picked = text(value.login) ?? text(value.name)
      return picked ? [picked] : []
    })
  }
}

export async function fetchProjects(
  credentials: YouTrackCredentials,
  force = false
): Promise<YouTrackProjectSummary[]> {
  const cached = force ? null : fresh(projectsCache)
  if (cached) {
    return cached
  }
  const raw = await youtrackRequest(
    credentials,
    '/api/admin/projects?fields=id,shortName,name,archived&$top=500'
  )
  const projects = records(raw)
    .filter((project) => project.archived !== true && text(project.id))
    .map((project) => ({
      id: String(project.id),
      shortName: text(project.shortName) ?? '',
      name: text(project.name) ?? text(project.shortName) ?? String(project.id)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  projectsCache = { at: Date.now(), value: projects }
  return projects
}

export async function fetchProjectFields(
  credentials: YouTrackCredentials,
  projectId: string,
  force = false
): Promise<YouTrackFieldSchema[]> {
  const cached = force ? null : fresh(fieldsCache.get(projectId))
  if (cached) {
    return cached
  }
  const raw = await youtrackRequest(
    credentials,
    `/api/admin/projects/${encodeURIComponent(projectId)}/customFields?fields=${encodeURIComponent(PROJECT_FIELDS)}&$top=200`
  )
  const fields = records(raw)
    .map(toFieldSchema)
    .filter((field) => field !== null)
  fieldsCache.set(projectId, { at: Date.now(), value: fields })
  return fields
}

export function clearProjectFieldCaches(): void {
  fieldsCache.clear()
  projectsCache = null
}
