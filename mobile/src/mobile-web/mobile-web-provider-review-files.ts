import {
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT,
  MobileWebProviderReviewFileSchema,
  type MobileWebProviderReviewFile,
  type MobileWebProviderReviewProvider
} from '../../../src/shared/mobile-web/provider-review-contract'

const MAX_GITLAB_DIFF_SCAN_CHARACTERS = 256 * 1024
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

export function sanitizeMobileWebProviderReviewFiles(
  provider: MobileWebProviderReviewProvider,
  value: unknown
): { items: MobileWebProviderReviewFile[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return { items: [], truncated: false }
  }
  const items: MobileWebProviderReviewFile[] = []
  let remainingLines = MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT
  let skipped = false
  for (const entry of value) {
    if (items.length >= MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT) {
      skipped = true
      break
    }
    const file = sanitizeReviewFile(provider, entry, remainingLines)
    if (!file) {
      skipped = true
      continue
    }
    items.push(file)
    remainingLines -= file.commentableLines.length
  }
  return {
    items,
    truncated: skipped || value.length > MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT
  }
}

export function sanitizedProviderReviewHead(details: unknown): string | undefined {
  if (!isRecord(details)) {
    return undefined
  }
  return boundedHead(details.headSha)
}

function sanitizeReviewFile(
  provider: MobileWebProviderReviewProvider,
  value: unknown,
  remainingLines: number
): MobileWebProviderReviewFile | null {
  if (!isRecord(value)) {
    return null
  }
  const path = safePath(value.path)
  if (!path) {
    return null
  }
  const oldPath = safePath(value.oldPath)
  const lineLimit = Math.min(MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT, remainingLines)
  const lines =
    provider === 'github'
      ? boundedLineNumbers(value.reviewCommentLineNumbers, lineLimit)
      : modifiedDiffLineNumbers(value.diff, lineLimit)
  const parsed = MobileWebProviderReviewFileSchema.safeParse({
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    status: fileStatus(value.status),
    additions: nonnegativeInteger(value.additions),
    deletions: nonnegativeInteger(value.deletions),
    isBinary: value.isBinary === true,
    commentableLines: lines.values,
    commentableLinesTruncated: lines.truncated
  })
  return parsed.success ? parsed.data : null
}

function boundedLineNumbers(
  value: unknown,
  limit: number
): { values: number[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return { values: [], truncated: false }
  }
  const values: number[] = []
  const seen = new Set<number>()
  let truncated = false
  for (const candidate of value) {
    if (!positiveInteger(candidate) || seen.has(candidate)) {
      continue
    }
    if (values.length >= limit) {
      truncated = true
      break
    }
    seen.add(candidate)
    values.push(candidate)
  }
  return { values, truncated }
}

function modifiedDiffLineNumbers(
  value: unknown,
  limit: number
): { values: number[]; truncated: boolean } {
  if (typeof value !== 'string' || value.length === 0) {
    return { values: [], truncated: false }
  }
  const scanLimit = Math.min(value.length, MAX_GITLAB_DIFF_SCAN_CHARACTERS)
  const values: number[] = []
  let nextLine: number | null = null
  let cursor = 0
  while (cursor <= scanLimit) {
    const nextBreak = value.indexOf('\n', cursor)
    const end = nextBreak === -1 || nextBreak > scanLimit ? scanLimit : nextBreak
    const line = value.slice(cursor, end)
    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      nextLine = Number.isInteger(start) && count > 0 ? start : null
    } else if (nextLine !== null && !line.startsWith('\\')) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        if (values.length >= limit) {
          return { values, truncated: true }
        }
        values.push(nextLine)
        nextLine += 1
      } else if (!line.startsWith('-')) {
        nextLine += 1
      }
    }
    if (nextBreak === -1 || nextBreak >= scanLimit) {
      break
    }
    cursor = nextBreak + 1
  }
  return { values, truncated: value.length > scanLimit }
}

function safePath(value: unknown): string | undefined {
  const result = MobileWebProviderReviewFileSchema.shape.path.safeParse(value)
  return result.success ? result.data : undefined
}

function boundedHead(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value
    : undefined
}

function fileStatus(value: unknown): MobileWebProviderReviewFile['status'] {
  return value === 'added' ||
    value === 'removed' ||
    value === 'renamed' ||
    value === 'copied' ||
    value === 'changed' ||
    value === 'unchanged'
    ? value
    : 'modified'
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
