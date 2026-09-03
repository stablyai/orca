import type {
  SentryAssignee,
  SentryBreadcrumb,
  SentryEvent,
  SentryException,
  SentryIssue,
  SentryOrganization,
  SentryProject,
  SentryStackFrame
} from '../../shared/sentry-types'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const string = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback
const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const number = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export function mapOrganization(value: unknown): SentryOrganization {
  const data = record(value)
  return {
    id: string(data.id),
    slug: string(data.slug),
    name: string(data.name, string(data.slug))
  }
}

export function mapProject(value: unknown): SentryProject {
  const data = record(value)
  return {
    id: string(data.id),
    slug: string(data.slug),
    name: string(data.name, string(data.slug)),
    platform: nullableString(data.platform)
  }
}

function mapAssignee(value: unknown): SentryAssignee | null {
  const data = record(value)
  const id = string(data.id)
  if (!id) {
    return null
  }
  return {
    type: data.type === 'team' ? 'team' : 'user',
    id,
    name: string(data.name, string(data.email, id)),
    email: nullableString(data.email)
  }
}

function mapFrame(value: unknown): SentryStackFrame {
  const data = record(value)
  return {
    filename: nullableString(data.filename),
    function: nullableString(data.function),
    module: nullableString(data.module),
    lineNo: data.lineNo == null ? null : number(data.lineNo),
    columnNo: data.colNo == null ? null : number(data.colNo),
    contextLine: nullableString(data.contextLine),
    inApp: typeof data.inApp === 'boolean' ? data.inApp : null
  }
}

function mapException(value: unknown): SentryException {
  const data = record(value)
  const stacktrace = record(data.stacktrace)
  return {
    type: nullableString(data.type),
    value: nullableString(data.value),
    module: nullableString(data.module),
    frames: array(stacktrace.frames).map(mapFrame)
  }
}

function mapBreadcrumb(value: unknown): SentryBreadcrumb {
  const data = record(value)
  return {
    timestamp: nullableString(data.timestamp),
    category: nullableString(data.category),
    type: nullableString(data.type),
    level: nullableString(data.level),
    message: nullableString(data.message),
    data: Object.keys(record(data.data)).length ? record(data.data) : null
  }
}

export function mapEvent(value: unknown): SentryEvent {
  const data = record(value)
  const entries = array(data.entries).map(record)
  const exceptionEntry = entries.find((entry) => entry.type === 'exception')
  const breadcrumbsEntry = entries.find((entry) => entry.type === 'breadcrumbs')
  const exceptionData = record(exceptionEntry?.data)
  const breadcrumbData = record(breadcrumbsEntry?.data)
  const release = record(data.release)
  return {
    id: string(data.id, string(data.eventID)),
    eventId: string(data.eventID, string(data.id)),
    title: string(data.title),
    dateCreated: string(data.dateCreated),
    environment: nullableString(data.environment),
    release: nullableString(release.version) ?? nullableString(data.release),
    platform: nullableString(data.platform),
    message: nullableString(data.message),
    exceptions: array(exceptionData.values).map(mapException),
    breadcrumbs: array(breadcrumbData.values).map(mapBreadcrumb),
    tags: array(data.tags).map((item) => {
      const tag = record(item)
      return { key: string(tag.key), value: string(tag.value) }
    }),
    contexts: record(data.contexts),
    request: Object.keys(record(data.request)).length ? record(data.request) : null,
    user: Object.keys(record(data.user)).length ? record(data.user) : null
  }
}

export function mapIssue(value: unknown): SentryIssue {
  const data = record(value)
  const priority =
    data.priority === 'low' || data.priority === 'medium' || data.priority === 'high'
      ? data.priority
      : null
  return {
    id: string(data.id),
    shortId: string(data.shortId, string(data.id)),
    title: string(data.title),
    culprit: string(data.culprit),
    permalink: string(data.permalink),
    project: mapProject(data.project),
    status: string(data.status, 'unresolved'),
    substatus: nullableString(data.substatus),
    level: string(data.level, 'error'),
    priority,
    assignedTo: mapAssignee(data.assignedTo),
    count: number(data.count),
    userCount: number(data.userCount),
    firstSeen: string(data.firstSeen),
    lastSeen: string(data.lastSeen),
    platform: nullableString(data.platform),
    issueCategory: nullableString(data.issueCategory),
    metadata: record(data.metadata),
    tags: array(data.tags).map((item) => {
      const tag = record(item)
      return { key: string(tag.key), name: string(tag.name), totalValues: number(tag.totalValues) }
    }),
    latestEvent: data.latestEvent ? mapEvent(data.latestEvent) : null
  }
}
