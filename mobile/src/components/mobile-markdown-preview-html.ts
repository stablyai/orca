// Why: README HTML snippets can document escaped entities; repeated cleanup
// passes must not turn `&amp;lt;` into a real tag and strip it.
const escapedHtmlEntityTokens = [
  { pattern: /&amp;nbsp;/gi, token: '\uE000ORCA_MD_ENTITY_NBSP\uE000', value: '&nbsp;' },
  { pattern: /&amp;lt;/gi, token: '\uE000ORCA_MD_ENTITY_LT\uE000', value: '&lt;' },
  { pattern: /&amp;gt;/gi, token: '\uE000ORCA_MD_ENTITY_GT\uE000', value: '&gt;' },
  { pattern: /&amp;quot;/gi, token: '\uE000ORCA_MD_ENTITY_QUOT\uE000', value: '&quot;' },
  { pattern: /&amp;#39;/gi, token: '\uE000ORCA_MD_ENTITY_APOS\uE000', value: '&#39;' }
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
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ''), true)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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

export function normalizeMobileMarkdownPreviewHtml(content: string): string {
  let next = content.replace(/\r\n?/g, '\n')

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

  return restoreEscapedHtmlEntities(next)
}
