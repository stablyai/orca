// Why: README HTML snippets can document escaped entities; repeated cleanup
// passes must not turn `&amp;lt;` into a real tag and strip it.
const escapedHtmlEntityTokens = [
  { pattern: /&amp;nbsp;/gi, token: '\uE000ORCA_MD_ENTITY_NBSP\uE000', value: '&nbsp;' },
  { pattern: /&amp;lt;/gi, token: '\uE000ORCA_MD_ENTITY_LT\uE000', value: '&lt;' },
  { pattern: /&amp;gt;/gi, token: '\uE000ORCA_MD_ENTITY_GT\uE000', value: '&gt;' },
  { pattern: /&amp;quot;/gi, token: '\uE000ORCA_MD_ENTITY_QUOT\uE000', value: '&quot;' },
  { pattern: /&amp;#39;/gi, token: '\uE000ORCA_MD_ENTITY_APOS\uE000', value: '&#39;' }
] as const

const strippableHtmlTagNames = new Set(
  [
    'a abbr address area article aside audio b base bdi bdo blockquote body br button',
    'canvas caption cite code col colgroup data datalist dd del details dfn dialog div',
    'dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head',
    'header hgroup hr html i iframe img input ins kbd label legend li link main map',
    'mark menu meta meter nav noscript object ol optgroup option output p picture pre',
    'progress q rp rt ruby s samp script search section select slot small source span',
    'strong style sub summary sup table tbody td template textarea tfoot th thead time',
    'title tr track u ul var video wbr'
  ]
    .join(' ')
    .split(' ')
)

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
    protectedText
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*)?\/?>/g, (tag, name: string) =>
        strippableHtmlTagNames.has(name.toLowerCase()) ? '' : tag
      ),
    true
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return restoreMarkdownCode(stripped, codeSpans, placeholderPrefix)
}

function attrValue(tag: string, name: string): string {
  const pattern = new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  const match = tag.match(pattern)
  const raw = match?.[1] ?? ''
  return decodeHtmlEntities(raw.replace(/^["']|["']$/g, ''))
}

function normalizeInlineHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, (tag) => attrValue(tag, 'alt') || 'image')
    .replace(
      /<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi,
      (tag, _href, label) => {
        const href = attrValue(tag, 'href')
        const text = stripTags(label)
        return href && text ? `[${text}](${href})` : text
      }
    )
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_tag, _name, inner) => {
      const text = stripTags(inner)
      return text ? `**${text}**` : ''
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_tag, _name, inner) => {
      const text = stripTags(inner)
      return text ? `*${text}*` : ''
    })
    .replace(/<(code|kbd)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_tag, _name, inner) => {
      const text = stripTags(inner)
      return text ? `\`${text}\`` : ''
    })
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
  next = next.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_tag, level, inner) => {
    const text = stripTags(normalizeInlineHtml(inner))
    return text ? `\n${'#'.repeat(Number(level))} ${text}\n` : '\n'
  })
  next = next.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_tag, inner) => {
    const text = stripTags(normalizeInlineHtml(inner))
    return text ? `\n${text}\n` : '\n'
  })
  next = next.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_tag, inner) =>
    stripTags(normalizeInlineHtml(inner))
  )
  next = normalizeInlineHtml(next)
  next = stripTags(next)

  return restoreMarkdownCode(restoreEscapedHtmlEntities(next), codeSpans, placeholderPrefix)
}
