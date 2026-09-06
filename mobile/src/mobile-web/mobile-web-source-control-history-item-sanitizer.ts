import {
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT,
  MobileWebGitObjectIdSchema,
  MobileWebSourceControlHistoryItemSchema,
  MobileWebSourceControlHistoryRefSchema,
  type MobileWebSourceControlHistoryItem,
  type MobileWebSourceControlHistoryRef
} from '../../../src/shared/mobile-web/source-control-history-contract'

export function sanitizeMobileWebHistoryItem(
  candidate: unknown
): MobileWebSourceControlHistoryItem | null {
  if (!isRecord(candidate)) {
    return null
  }
  const id = sanitizeObjectId(candidate.id)
  if (!id) {
    return null
  }
  const parentIds = Array.isArray(candidate.parentIds)
    ? candidate.parentIds
        .slice(0, MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT)
        .flatMap((value) => {
          const parent = sanitizeObjectId(value)
          return parent ? [parent] : []
        })
    : []
  const references = Array.isArray(candidate.references)
    ? candidate.references
        .slice(0, MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT)
        .flatMap((value) => {
          const reference = sanitizeMobileWebHistoryRef(value)
          return reference ? [reference] : []
        })
    : []
  const message = boundedString(candidate.message, 8 * 1024) ?? ''
  const subject =
    boundedString(candidate.subject, 512) ??
    boundedString(message.split(/\r?\n/, 1)[0], 512) ??
    '(no commit message)'
  const author = boundedString(candidate.author, 256)
  const timestamp = boundedTimestamp(candidate.timestamp)
  return MobileWebSourceControlHistoryItemSchema.parse({
    id,
    parentIds,
    displayId: id.slice(0, 12),
    subject,
    message,
    ...(author === undefined ? {} : { author }),
    ...(timestamp === undefined ? {} : { timestamp }),
    references
  })
}

export function sanitizeMobileWebHistoryRef(
  candidate: unknown
): MobileWebSourceControlHistoryRef | null {
  if (!isRecord(candidate)) {
    return null
  }
  const id = boundedString(candidate.id, 320)
  const name = boundedString(candidate.name, 240)
  if (!id || !name) {
    return null
  }
  const revision = sanitizeObjectId(candidate.revision)
  const category =
    candidate.category === 'branches' ||
    candidate.category === 'remote branches' ||
    candidate.category === 'tags' ||
    candidate.category === 'commits'
      ? candidate.category
      : undefined
  const description = boundedString(candidate.description, 512)
  const parsed = MobileWebSourceControlHistoryRefSchema.safeParse({
    id,
    name,
    ...(revision ? { revision } : {}),
    ...(category ? { category } : {}),
    ...(description === undefined ? {} : { description })
  })
  return parsed.success ? parsed.data : null
}

function sanitizeObjectId(value: unknown): string | null {
  const parsed = MobileWebGitObjectIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function boundedTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= -8_640_000_000_000_000 &&
    value <= 8_640_000_000_000_000
    ? value
    : undefined
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
