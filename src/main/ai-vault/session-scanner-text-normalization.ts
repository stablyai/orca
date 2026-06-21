const SESSION_TITLE_TEXT_LIMIT = 96
const SESSION_PREVIEW_TEXT_LIMIT = 220
const ELLIPSIS = '...'
const HIDDEN_BLOCK_CLOSE_SCAN_LIMIT = 256 * 1024
const HIDDEN_BLOCK_OPEN_TAG_SCAN_LIMIT = 512
const FIELD_BLANK_SCAN_LIMIT = 1024

const AGENTS_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions for'
const XML_INSTRUCTIONS_PREFIX = '<INSTRUCTIONS>'

const HIDDEN_TEXT_BLOCKS = [
  { name: 'system-reminder', closeTag: '</system-reminder>' },
  { name: 'codex_internal_context', closeTag: '</codex_internal_context>' },
  { name: 'goal_context', closeTag: '</goal_context>' }
] as const

type TextBuilder = {
  readonly limit: number
  text: string
  pendingSpace: boolean
  truncated: boolean
}

export function extractMessageText(value: unknown): string | null {
  const message = objectRecord(value)
  return message ? extractContentText(message.content) : null
}

export function extractContentText(value: unknown): string | null {
  return normalizeContentText(value, SESSION_TITLE_TEXT_LIMIT)
}

export function normalizeTitleText(value: string): string | null {
  return finalizeNormalizedText(normalizeStringText(value, SESSION_TITLE_TEXT_LIMIT))
}

export function extractPreviewContentText(value: unknown): string | null {
  return normalizeContentText(value, SESSION_PREVIEW_TEXT_LIMIT)
}

export function normalizePreviewText(value: string): string | null {
  return finalizeNormalizedText(normalizeStringText(value, SESSION_PREVIEW_TEXT_LIMIT))
}

function normalizeContentText(value: unknown, limit: number): string | null {
  if (typeof value === 'string') {
    return finalizeNormalizedText(normalizeStringText(value, limit))
  }
  if (!Array.isArray(value)) {
    return null
  }

  const builder = createTextBuilder(limit)
  for (const item of value) {
    const text = contentItemText(item)
    if (text === null) {
      continue
    }
    appendInterPartSpace(builder)
    appendNormalizedString(builder, text)
    if (builder.truncated) {
      break
    }
  }

  return finalizeNormalizedText(builder)
}

function normalizeStringText(value: string, limit: number): TextBuilder {
  const builder = createTextBuilder(limit)
  appendNormalizedString(builder, value)
  return builder
}

function createTextBuilder(limit: number): TextBuilder {
  return { limit, text: '', pendingSpace: false, truncated: false }
}

function contentItemText(item: unknown): string | null {
  if (typeof item === 'string') {
    return item
  }

  const record = objectRecord(item)
  if (!record) {
    return null
  }

  return nonBlankString(record.text) ?? nonBlankString(record.content)
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return hasNonWhitespace(value, FIELD_BLANK_SCAN_LIMIT) ? value : null
}

function hasNonWhitespace(value: string, maxScanLength: number): boolean {
  const scanLimit = Math.min(value.length, maxScanLength)
  for (let index = 0; index < scanLimit; index += 1) {
    if (!isWhitespaceCode(value.charCodeAt(index))) {
      return true
    }
  }
  return value.length > scanLimit
}

function appendInterPartSpace(builder: TextBuilder): void {
  if (builder.text.length > 0) {
    builder.pendingSpace = true
  }
}

function appendNormalizedString(builder: TextBuilder, value: string): void {
  let index = 0
  while (index < value.length && !builder.truncated) {
    const hiddenBlockEnd = hiddenTextBlockEnd(value, index)
    if (hiddenBlockEnd !== null) {
      if (builder.text.length > 0) {
        builder.pendingSpace = true
      }
      index = hiddenBlockEnd
      continue
    }

    const code = value.charCodeAt(index)
    if (isWhitespaceCode(code)) {
      if (builder.text.length > 0) {
        builder.pendingSpace = true
      }
      index += 1
      continue
    }

    if (builder.pendingSpace) {
      appendVisibleText(builder, ' ')
      builder.pendingSpace = false
      if (builder.truncated) {
        break
      }
    }

    const charLength = codePointLength(value, index)
    appendVisibleText(builder, value.slice(index, index + charLength))
    index += charLength
  }
}

function appendVisibleText(builder: TextBuilder, value: string): void {
  builder.text += value
  builder.truncated = builder.text.length > builder.limit
}

function hiddenTextBlockEnd(value: string, index: number): number | null {
  if (value.charCodeAt(index) !== 60) {
    return null
  }

  for (const block of HIDDEN_TEXT_BLOCKS) {
    const nameStart = index + 1
    if (!startsWithIgnoreCase(value, block.name, nameStart)) {
      continue
    }

    const afterName = nameStart + block.name.length
    if (!isTagBoundary(value.charCodeAt(afterName))) {
      continue
    }

    const openEnd = tagEndIndex(value, afterName)
    if (openEnd === null) {
      // Why: malformed hidden context should not leak into AI Vault titles/previews.
      return value.length
    }

    const closeStart = indexOfIgnoreCase(
      value,
      block.closeTag,
      openEnd + 1,
      openEnd + 1 + HIDDEN_BLOCK_CLOSE_SCAN_LIMIT
    )
    return closeStart === -1 ? value.length : closeStart + block.closeTag.length
  }

  return null
}

function tagEndIndex(value: string, fromIndex: number): number | null {
  const scanEnd = Math.min(value.length, fromIndex + HIDDEN_BLOCK_OPEN_TAG_SCAN_LIMIT)
  for (let index = fromIndex; index < scanEnd; index += 1) {
    if (value.charCodeAt(index) === 62) {
      return index
    }
  }
  return null
}

function indexOfIgnoreCase(
  value: string,
  search: string,
  fromIndex: number,
  endIndex: number
): number {
  const lastStart = Math.min(value.length, endIndex, value.length - search.length + 1)
  for (let index = fromIndex; index < lastStart; index += 1) {
    if (startsWithIgnoreCase(value, search, index)) {
      return index
    }
  }
  return -1
}

function finalizeNormalizedText(builder: TextBuilder): string | null {
  if (!builder.text) {
    return null
  }
  if (isSuppressedContextPrefix(builder.text)) {
    return null
  }
  return builder.truncated ? truncateWithEllipsis(builder.text, builder.limit) : builder.text
}

function isSuppressedContextPrefix(value: string): boolean {
  return (
    (startsWithIgnoreCase(value, AGENTS_INSTRUCTIONS_PREFIX, 0) &&
      isWordBoundary(value.charCodeAt(AGENTS_INSTRUCTIONS_PREFIX.length))) ||
    startsWithIgnoreCase(value, XML_INSTRUCTIONS_PREFIX, 0)
  )
}

function truncateWithEllipsis(value: string, limit: number): string {
  const end = Math.max(0, limit - ELLIPSIS.length)
  const safeEnd = end > 0 && isHighSurrogate(value.charCodeAt(end - 1)) ? end - 1 : end
  return `${value.slice(0, safeEnd)}${ELLIPSIS}`
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function startsWithIgnoreCase(value: string, search: string, fromIndex: number): boolean {
  if (fromIndex + search.length > value.length) {
    return false
  }
  for (let index = 0; index < search.length; index += 1) {
    if (
      toLowerAscii(value.charCodeAt(fromIndex + index)) !== toLowerAscii(search.charCodeAt(index))
    ) {
      return false
    }
  }
  return true
}

function toLowerAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function isTagBoundary(code: number): boolean {
  return Number.isNaN(code) || code === 62 || isWhitespaceCode(code)
}

function isWordBoundary(code: number): boolean {
  return Number.isNaN(code) || !isWordCode(code)
}

function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  )
}

function isWhitespaceCode(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function codePointLength(value: string, index: number): number {
  const code = value.charCodeAt(index)
  return isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(index + 1)) ? 2 : 1
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
