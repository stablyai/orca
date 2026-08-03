import {
  findMobileMarkdownMarkupTagEnd,
  findNextPairedMarkupOpener,
  isPairedMarkupOpener,
  replaceMobileMarkdownPairedMarkupTags,
  stripMobileMarkdownMarkupTags
} from './mobile-markdown-preview-tag-stripper'

// Why: README HTML snippets can document escaped entities; repeated cleanup
// passes must not turn `&amp;lt;` into a real tag and strip it.
const escapedHtmlEntityTokens = [
  { pattern: /&amp;nbsp;/gi, token: '\uE000ORCA_MD_ENTITY_NBSP\uE000', value: '&nbsp;' },
  { pattern: /&amp;lt;/gi, token: '\uE000ORCA_MD_ENTITY_LT\uE000', value: '&lt;' },
  { pattern: /&amp;gt;/gi, token: '\uE000ORCA_MD_ENTITY_GT\uE000', value: '&gt;' },
  { pattern: /&amp;quot;/gi, token: '\uE000ORCA_MD_ENTITY_QUOT\uE000', value: '&quot;' },
  { pattern: /&amp;#39;/gi, token: '\uE000ORCA_MD_ENTITY_APOS\uE000', value: '&#39;' },
  { pattern: /&lt;/gi, token: '\uE000ORCA_MD_ENTITY_RAW_LT\uE000', value: '<' },
  { pattern: /&gt;/gi, token: '\uE000ORCA_MD_ENTITY_RAW_GT\uE000', value: '>' }
] as const

function protectEscapedHtmlEntities(value: string): string {
  return escapedHtmlEntityTokens.reduce(
    (next, entity) => next.replace(entity.pattern, entity.token),
    value
  )
}

function restoreEscapedHtmlEntities(value: string): string {
  return escapedHtmlEntityTokens.reduce(
    (next, entity) => next.replaceAll(entity.token, entity.value),
    value
  )
}

function decodeHtmlEntities(value: string, preserveEscapedEntities = false): string {
  const next = preserveEscapedEntities ? protectEscapedHtmlEntities(value) : value

  return next
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTags(value: string): string {
  const { protectedText, codeSpans, placeholderPrefix } = protectMarkdownCode(value)
  const stripped = decodeHtmlEntities(
    stripMobileMarkdownMarkupTags(protectedText.replace(/<!--[\s\S]*?-->/g, '')),
    true
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return restoreMarkdownCode(stripped, codeSpans, placeholderPrefix)
}

function attrValue(tag: string, name: string): string {
  let cursor = 1
  while (cursor < tag.length && !/[\s/>]/.test(tag[cursor] ?? '')) {
    cursor += 1
  }
  while (cursor < tag.length) {
    while (/\s/.test(tag[cursor] ?? '')) {
      cursor += 1
    }
    if (tag[cursor] === '>' || (tag[cursor] === '/' && tag[cursor + 1] === '>')) {
      return ''
    }

    const attributeStart = cursor
    while (!/[\s=/>]/.test(tag[cursor] ?? '>')) {
      cursor += 1
    }
    if (attributeStart === cursor) {
      cursor += 1
      continue
    }
    const attributeName = tag.slice(attributeStart, cursor)
    while (/\s/.test(tag[cursor] ?? '')) {
      cursor += 1
    }
    if (tag[cursor] !== '=') {
      continue
    }

    cursor += 1
    while (/\s/.test(tag[cursor] ?? '')) {
      cursor += 1
    }
    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor] : ''
    if (quote) {
      cursor += 1
    }
    const valueStart = cursor
    if (quote) {
      const valueEnd = tag.indexOf(quote, cursor)
      if (valueEnd < 0) {
        return ''
      }
      cursor = valueEnd + 1
      if (attributeName.toLowerCase() === name) {
        return decodeHtmlEntities(tag.slice(valueStart, valueEnd))
      }
      continue
    }

    while (!/[\s>]/.test(tag[cursor] ?? '>')) {
      cursor += 1
    }
    if (attributeName.toLowerCase() === name) {
      return decodeHtmlEntities(tag.slice(valueStart, cursor))
    }
  }
  return ''
}

const tagAttributesSource = `(?:[^<>"']|"[^"]*"|'[^']*')*`
const imageTagPattern = new RegExp(`<img\\b${tagAttributesSource}>`, 'gi')

function normalizeAnchorTags(value: string): string {
  const lowerValue = value.toLowerCase()
  let output = ''
  let copyCursor = 0
  let searchCursor = 0
  let closingStart = -1

  while (searchCursor < value.length) {
    const start = findNextPairedMarkupOpener(value, lowerValue, 'a', searchCursor)
    if (start < 0) {
      break
    }
    const end = findMobileMarkdownMarkupTagEnd(value, start + 2)
    if (end < 0) {
      if (end === -2) {
        break
      }
      searchCursor = start + 2
      continue
    }
    if (!isPairedMarkupOpener(value, start + 2, end)) {
      searchCursor = end + 1
      continue
    }

    const tag = value.slice(start, end + 1)
    const href = attrValue(tag, 'href')
    if (!href) {
      searchCursor = end + 1
      continue
    }

    if (closingStart < end + 1) {
      closingStart = lowerValue.indexOf('</a>', end + 1)
    }
    if (closingStart < 0) {
      break
    }
    const nestedStart = findNextPairedMarkupOpener(value, lowerValue, 'a', end + 1)
    if (nestedStart >= 0 && nestedStart < closingStart) {
      searchCursor = nestedStart
      continue
    }

    const text = stripTags(value.slice(end + 1, closingStart))
    output += value.slice(copyCursor, start)
    output += href && text ? `[${text}](${href})` : text
    copyCursor = closingStart + 4
    searchCursor = copyCursor
  }

  return output + value.slice(copyCursor)
}

function normalizeInlineHtml(value: string): string {
  const imagesNormalized = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(imageTagPattern, (tag) => attrValue(tag, 'alt') || 'image')

  let next = normalizeAnchorTags(imagesNormalized)
  next = replaceMobileMarkdownPairedMarkupTags(next, ['strong', 'b'], (_name, inner) => {
    const text = stripTags(inner)
    return text ? `**${text}**` : ''
  })
  next = replaceMobileMarkdownPairedMarkupTags(next, ['em', 'i'], (_name, inner) => {
    const text = stripTags(inner)
    return text ? `*${text}*` : ''
  })
  next = replaceMobileMarkdownPairedMarkupTags(next, ['code', 'kbd'], (_name, inner) => {
    const text = stripTags(inner)
    return text ? `\`${text}\`` : ''
  })
  return next
}

// Why: Markdown code is literal source, so it must bypass the HTML strip pass.
const CODE_PLACEHOLDER_PREFIX_BASE = '\uE000ORCA_MD_CODE_'
const CODE_PLACEHOLDER_SUFFIX = '\uE000'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function codePlaceholderPrefix(content: string): string {
  let prefix = CODE_PLACEHOLDER_PREFIX_BASE
  while (content.includes(prefix)) {
    prefix = `${prefix}_`
  }
  return prefix
}

function protectMarkdownCode(content: string): {
  protectedText: string
  codeSpans: string[]
  placeholderPrefix: string
} {
  const placeholderPrefix = codePlaceholderPrefix(content)
  const codeSpans: string[] = []
  const store = (match: string): string => {
    const token = `${placeholderPrefix}${codeSpans.length}${CODE_PLACEHOLDER_SUFFIX}`
    codeSpans.push(match)
    return token
  }

  const lines = content.split('\n')
  const protectedLines: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^```[A-Za-z0-9_-]*\s*$/.test(line)) {
      const start = index
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      protectedLines.push(store(lines.slice(start, index).join('\n')))
      continue
    }

    protectedLines.push(line.replace(/`[^`\n]+`/g, store))
    index += 1
  }

  return { protectedText: protectedLines.join('\n'), codeSpans, placeholderPrefix }
}

function restoreMarkdownCode(
  value: string,
  codeSpans: string[],
  placeholderPrefix: string
): string {
  const placeholderPattern = new RegExp(
    `${escapeRegExp(placeholderPrefix)}(\\d+)${escapeRegExp(CODE_PLACEHOLDER_SUFFIX)}`,
    'g'
  )
  return value.replace(placeholderPattern, (_token, index) => codeSpans[Number(index)] ?? _token)
}

export function normalizeMobileMarkdownPreviewHtml(content: string): string {
  const { protectedText, codeSpans, placeholderPrefix } = protectMarkdownCode(
    content.replace(/\r\n?/g, '\n')
  )
  let next = protectedText

  // Why: repository Markdown often uses small HTML islands for centered README
  // headers and badges. Preview mode should read like Markdown, while Source
  // mode remains the exact file bytes.
  next = replaceMobileMarkdownPairedMarkupTags(
    next,
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    (name, inner) => {
      const text = stripTags(normalizeInlineHtml(inner))
      return text ? `\n${'#'.repeat(Number(name.slice(1)))} ${text}\n` : '\n'
    }
  )
  next = replaceMobileMarkdownPairedMarkupTags(next, ['p'], (_name, inner) => {
    const text = stripTags(normalizeInlineHtml(inner))
    return text ? `\n${text}\n` : '\n'
  })
  next = replaceMobileMarkdownPairedMarkupTags(next, ['sub'], (_name, inner) =>
    stripTags(normalizeInlineHtml(inner))
  )
  next = normalizeInlineHtml(next)
  next = stripTags(next)

  return restoreMarkdownCode(restoreEscapedHtmlEntities(next), codeSpans, placeholderPrefix)
}
