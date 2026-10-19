import { escapeMarkdownLinkDestination } from './adf-media-destination'

type JiraAdfRecord = Record<string, unknown>

function isRecord(value: unknown): value is JiraAdfRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): JiraAdfRecord {
  return isRecord(value) ? value : {}
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
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_~[\]<>])/g, '\\$1')
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

export function joinAdfInlineMarkdown(fragments: { markdown: string; marks: unknown }[]): string {
  let result = ''
  for (const { markdown, marks } of fragments) {
    if (markdown.startsWith('[') && linkHrefFromMarks(asArray(marks)) && result.endsWith('!')) {
      let slashCount = 0
      for (let index = result.length - 2; index >= 0 && result[index] === '\\'; index -= 1) {
        slashCount += 1
      }
      // A punctuation bang from the preceding text must not turn this link into an image.
      if (slashCount % 2 === 0) {
        result = `${result.slice(0, -1)}\\!`
      }
    }
    result += markdown
  }
  return result
}

/** Keep formatting inside the link label so Markdown preserves both. */
export function applyAdfTextMarks(text: string, marksValue: unknown): string {
  const marks = asArray(marksValue)
  if (!text || marks.length === 0) {
    return text
  }

  if (!marks.some((mark) => ['link', 'code', 'strong', 'em', 'strike'].includes(markType(mark)))) {
    return text
  }

  const href = linkHrefFromMarks(marks)
  const linkedText = href ? text.replace(/\r\n?|\n/g, ' ') : text
  let formatted = linkedText
  // Why: code spans cannot nest other Markdown; apply code before bold/em/strike.
  if (marks.some((mark) => markType(mark) === 'code')) {
    let longestBacktickRun = 0
    for (const match of linkedText.matchAll(/`+/g)) {
      longestBacktickRun = Math.max(longestBacktickRun, match[0].length)
    }
    const fence = '`'.repeat(longestBacktickRun + 1)
    // Padding keeps edge backticks from joining the code-span delimiter.
    const padding = /^`|`$|^ .* $/s.test(linkedText) && /[^ ]/.test(linkedText) ? ' ' : ''
    formatted = `${fence}${padding}${linkedText}${padding}${fence}`
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
  // Unsafe destinations retain the label without becoming clickable.
  if (!safeUrl) {
    return formatted
  }

  return `[${formatted}](${safeUrl})`
}
