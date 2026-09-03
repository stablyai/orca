import { escapeMarkdownLinkDestination } from './adf-media-destination'

type JiraAdfRecord = Record<string, unknown>

function asRecord(value: unknown): JiraAdfRecord {
  return value && typeof value === 'object' ? (value as JiraAdfRecord) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Escape Markdown punctuation in source text before adding mark delimiters. */
export function escapeMarkdownLinkLabel(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([`*_~[\]])/g, '\\$1')
    .replace(/\r\n?|\n/g, ' ')
}

function markType(mark: unknown): string {
  return asString(asRecord(mark).type)
}

function linkHrefFromMarks(marks: unknown[]): string | undefined {
  for (const mark of marks) {
    if (markType(mark) !== 'link') {
      continue
    }
    const href = asString(asRecord(asRecord(mark).attrs).href).trim()
    if (href) {
      return href
    }
  }
  return undefined
}

/**
 * Apply ADF text marks. Formatting is nested inside the link so CommonMark keeps
 * both the destination and emphasis (e.g. [**label**](url)).
 */
export function applyAdfTextMarks(text: string, marksValue: unknown): string {
  const marks = asArray(marksValue)
  if (!text || marks.length === 0) {
    return text
  }

  const href = linkHrefFromMarks(marks)
  const linkedText = href ? text.replace(/\r\n?|\n/g, ' ') : text
  let formatted = linkedText
  // Why: code spans cannot nest other Markdown; apply code before bold/em/strike.
  if (marks.some((mark) => markType(mark) === 'code')) {
    const longestBacktickRun = Math.max(
      0,
      ...Array.from(linkedText.matchAll(/`+/g), (match) => match[0].length)
    )
    const fence = '`'.repeat(longestBacktickRun + 1)
    formatted = `${fence}${linkedText}${fence}`
  } else {
    formatted = escapeMarkdownLinkLabel(formatted)
    if (marks.some((mark) => markType(mark) === 'strong')) {
      formatted = `**${formatted}**`
    }
    if (marks.some((mark) => markType(mark) === 'em')) {
      formatted = `*${formatted}*`
    }
    if (marks.some((mark) => markType(mark) === 'strike')) {
      formatted = `~~${formatted}~~`
    }
  }

  if (!href) {
    return formatted
  }

  const safeUrl = escapeMarkdownLinkDestination(href)
  // Why: unsafe schemes must stay non-clickable text; keep visible label + marks.
  if (!safeUrl) {
    return formatted
  }

  return `[${formatted}](${safeUrl})`
}
