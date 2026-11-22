// Tag scans only move forward: rescanning from every unclosed opener is quadratic on
// a malformed page, and this parse blocks the main or runtime event loop.

/** Index of the `>` closing a tag, skipping any inside quoted attribute values; -1 when none closes it. */
function findTagEnd(html: string, from: number): number {
  let afterEquals = false
  for (let i = from; i < html.length; i++) {
    const ch = html[i]
    if (afterEquals && (ch === '"' || ch === "'")) {
      const close = html.indexOf(ch, i + 1)
      if (close === -1) {
        return -1
      }
      i = close
      afterEquals = false
    } else if (ch === '>') {
      return i
    } else if (ch === '=') {
      afterEquals = true
    } else if (!/\s/.test(ch)) {
      afterEquals = false
    }
  }
  return -1
}

/** Attributes of each `<tagName ...>` in document order; stops at the first unclosed tag. */
export function* htmlTagAttributes(html: string, tagName: string): Generator<Map<string, string>> {
  const open = new RegExp(`<${tagName}\\b`, 'gi')
  while (open.test(html)) {
    const end = findTagEnd(html, open.lastIndex)
    if (end === -1) {
      return
    }
    const tag = html.slice(open.lastIndex, end)
    open.lastIndex = end + 1
    const attributes = new Map<string, string>()
    // Names start after whitespace so a long unquoted run cannot backtrack from every offset.
    for (const [, name, double, single, bare] of tag.matchAll(
      /(?:^|\s)([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    )) {
      attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
    }
    yield attributes
  }
}

export function extractHtmlTitle(html: string): string | null {
  const open = /<title\b/gi
  if (!open.test(html)) {
    return null
  }
  const tagEnd = html.indexOf('>', open.lastIndex)
  if (tagEnd === -1) {
    return null
  }
  const close = /<\/title>/gi
  close.lastIndex = tagEnd + 1
  const end = close.exec(html)
  if (!end) {
    return null
  }
  return normalizeHtmlText(html.slice(tagEnd + 1, end.index)) || null
}

export function findIconHref(html: string): string | null {
  for (const attributes of htmlTagAttributes(html, 'link')) {
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attributes.get('href')
    if (rel.includes('icon') && href) {
      return decodeHtmlEntities(href)
    }
  }
  return null
}

/** Decodes entities and collapses whitespace, as a browser shows the text. */
export function normalizeHtmlText(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
}

// The named entities page titles and descriptions use; numeric references cover the rest.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  times: '\u00d7',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  rarr: '\u2192',
  larr: '\u2190'
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}
