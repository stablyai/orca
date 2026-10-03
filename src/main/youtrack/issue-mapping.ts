import type {
  YouTrackColor,
  YouTrackComment,
  YouTrackFieldValue,
  YouTrackIssue,
  YouTrackLinkGroup,
  YouTrackLinkedIssue,
  YouTrackState,
  YouTrackUser
} from '../../shared/youtrack-types'
import { isRawRecord, type RawRecord } from './raw-record'

const VALUE_FIELDS =
  '$type,id,name,login,fullName,avatarUrl,isResolved,presentation,text,color(background,foreground)'
const USER_FIELDS = 'id,login,fullName,email,avatarUrl'

const BASE_ISSUE_FIELDS = [
  'id',
  'idReadable',
  'summary',
  'created',
  'updated',
  'resolved',
  'project(id,shortName,name)',
  `reporter(${USER_FIELDS})`,
  'tags(name,color(background,foreground))',
  `customFields($type,name,value(${VALUE_FIELDS}))`
]

export const LIST_ISSUE_FIELDS = [
  ...BASE_ISSUE_FIELDS,
  'links(direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved))'
].join(',')

export const DETAIL_ISSUE_FIELDS = [
  ...BASE_ISSUE_FIELDS,
  'description',
  'links(direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved,customFields($type,name,value(name))))'
].join(',')

export const COMMENT_FIELDS = `id,text,created,updated,deleted,author(${USER_FIELDS})`

const STATE_FIELD_TYPES = new Set(['StateIssueCustomField', 'StateMachineIssueCustomField'])

function asRecord(value: unknown): RawRecord | null {
  return isRawRecord(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toIso(value: unknown): string {
  return typeof value === 'number' ? new Date(value).toISOString() : new Date(0).toISOString()
}

function toColor(value: unknown): YouTrackColor | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  return { background: asString(record.background), foreground: asString(record.foreground) }
}

function absoluteUrl(baseUrl: string, value: unknown): string | undefined {
  const raw = asString(value)
  if (!raw) {
    return undefined
  }
  try {
    return new URL(raw, `${baseUrl}/`).toString()
  } catch {
    return undefined
  }
}

export function toYouTrackUser(value: unknown, baseUrl: string): YouTrackUser | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const login = asString(record.login) ?? ''
  const avatarUrl = absoluteUrl(baseUrl, record.avatarUrl)
  return {
    id: asString(record.id) ?? login,
    login,
    fullName: asString(record.fullName) ?? login,
    email: asString(record.email),
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

function formatFieldValue(fieldType: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => formatFieldValue(fieldType, entry)).filter(Boolean)
    return parts.length > 0 ? parts.join(', ') : null
  }
  const record = asRecord(value)
  if (record) {
    return (
      asString(record.fullName) ??
      asString(record.name) ??
      asString(record.presentation) ??
      asString(record.text) ??
      asString(record.login)
    )
  }
  if (typeof value === 'number' && fieldType.startsWith('Date')) {
    return new Date(value).toISOString().slice(0, 10)
  }
  return String(value)
}

/** Editor-facing values: option names / user logins, or the plain text an input edits. */
function rawFieldValues(fieldType: string, value: unknown): string[] {
  if (value === null || value === undefined) {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => rawFieldValues(fieldType, entry))
  }
  const record = asRecord(value)
  if (record) {
    const raw =
      asString(record.login) ??
      asString(record.name) ??
      asString(record.presentation) ??
      (typeof record.text === 'string' ? record.text : null)
    return raw === null ? [] : [raw]
  }
  if (typeof value === 'number' && fieldType.startsWith('Date')) {
    return [new Date(value).toISOString().slice(0, 10)]
  }
  return [String(value)]
}

/** Maps a link label to its blocking direction; YouTrack's default "Depend" type reads "depends on" / "is required for". */
function classifyLinkLabel(label: string): YouTrackLinkGroup['blocking'] {
  if (/depends on|blocked by/i.test(label)) {
    return 'blocked-by'
  }
  if (/is required for|\bblocks\b/i.test(label)) {
    return 'blocks'
  }
  return null
}

function findStateName(customFields: unknown): string | null {
  if (!Array.isArray(customFields)) {
    return null
  }
  for (const field of customFields) {
    const record = asRecord(field)
    if (record && STATE_FIELD_TYPES.has(String(record.$type))) {
      return asString(asRecord(record.value)?.name)
    }
  }
  return null
}

function toLinkedIssue(value: unknown): YouTrackLinkedIssue | null {
  const record = asRecord(value)
  const idReadable = asString(record?.idReadable)
  if (!record || !idReadable) {
    return null
  }
  return {
    id: asString(record.id) ?? idReadable,
    idReadable,
    summary: asString(record.summary) ?? '',
    resolved: typeof record.resolved === 'number',
    state: findStateName(record.customFields)
  }
}

function toLinkGroups(value: unknown): YouTrackLinkGroup[] {
  if (!Array.isArray(value)) {
    return []
  }
  const groups: YouTrackLinkGroup[] = []
  for (const link of value) {
    const record = asRecord(link)
    const linkType = asRecord(record?.linkType)
    if (!record || !linkType || !Array.isArray(record.issues) || record.issues.length === 0) {
      continue
    }
    const linkTypeName = asString(linkType.name) ?? 'Link'
    const label =
      (record.direction === 'INWARD'
        ? asString(linkType.targetToSource)
        : asString(linkType.sourceToTarget)) ?? linkTypeName
    const issues = record.issues
      .map(toLinkedIssue)
      .filter((issue): issue is YouTrackLinkedIssue => issue !== null)
    if (issues.length > 0) {
      groups.push({ label, linkTypeName, blocking: classifyLinkLabel(label), issues })
    }
  }
  // Blockers first: they decide whether work can start.
  const rank = (group: YouTrackLinkGroup): number =>
    group.blocking === 'blocked-by' ? 0 : group.blocking === 'blocks' ? 1 : 2
  return groups.sort((a, b) => rank(a) - rank(b))
}

export function toYouTrackIssue(raw: unknown, baseUrl: string): YouTrackIssue | null {
  const record = asRecord(raw)
  const idReadable = asString(record?.idReadable)
  if (!record || !idReadable) {
    return null
  }
  const project = asRecord(record.project)
  let state: YouTrackState | null = null
  let stateFieldName: string | null = null
  let assignee: YouTrackUser | null = null
  let priority: string | null = null
  let type: string | null = null
  const fields: YouTrackFieldValue[] = []

  for (const field of Array.isArray(record.customFields) ? record.customFields : []) {
    const fieldRecord = asRecord(field)
    if (!fieldRecord) {
      continue
    }
    const fieldType = String(fieldRecord.$type ?? '')
    const name = asString(fieldRecord.name) ?? ''
    const value = asRecord(fieldRecord.value)
    fields.push({
      name,
      value: formatFieldValue(fieldType, fieldRecord.value),
      raw: rawFieldValues(fieldType, fieldRecord.value)
    })
    if (!stateFieldName && STATE_FIELD_TYPES.has(fieldType)) {
      stateFieldName = name
      state = value
        ? {
            name: asString(value.name) ?? '',
            isResolved: value.isResolved === true,
            color: toColor(value.color)
          }
        : null
    } else if (!assignee && fieldType === 'SingleUserIssueCustomField' && /assignee/i.test(name)) {
      assignee = toYouTrackUser(value, baseUrl)
    } else if (priority === null && /^priority$/i.test(name)) {
      priority = formatFieldValue(fieldType, fieldRecord.value)
    } else if (type === null && /^type$/i.test(name)) {
      type = formatFieldValue(fieldType, fieldRecord.value)
    }
  }

  const links = toLinkGroups(record.links)
  const unresolvedBlockerCount = links
    .filter((group) => group.blocking === 'blocked-by')
    .reduce((count, group) => count + group.issues.filter((issue) => !issue.resolved).length, 0)

  return {
    id: asString(record.id) ?? idReadable,
    idReadable,
    summary: asString(record.summary) ?? idReadable,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    url: `${baseUrl}/issue/${encodeURIComponent(idReadable)}`,
    project: {
      id: asString(project?.id) ?? '',
      shortName: asString(project?.shortName) ?? idReadable.split('-')[0],
      name: asString(project?.name) ?? ''
    },
    state,
    stateFieldName,
    assignee,
    reporter: toYouTrackUser(record.reporter, baseUrl),
    priority,
    type,
    fields,
    tags: Array.isArray(record.tags)
      ? record.tags
          .map(asRecord)
          .filter((tag): tag is RawRecord => tag !== null && asString(tag.name) !== null)
          .map((tag) => ({ name: String(tag.name), color: toColor(tag.color) }))
      : [],
    links,
    unresolvedBlockerCount,
    resolved: typeof record.resolved === 'number',
    createdAt: toIso(record.created),
    updatedAt: toIso(record.updated)
  }
}

export function toYouTrackComment(raw: unknown, baseUrl: string): YouTrackComment | null {
  const record = asRecord(raw)
  const id = asString(record?.id)
  if (!record || !id || record.deleted === true) {
    return null
  }
  const author = toYouTrackUser(record.author, baseUrl)
  return {
    id,
    text: typeof record.text === 'string' ? record.text : '',
    createdAt: toIso(record.created),
    ...(typeof record.updated === 'number' ? { updatedAt: toIso(record.updated) } : {}),
    ...(author ? { author } : {})
  }
}
