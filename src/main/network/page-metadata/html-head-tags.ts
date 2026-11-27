// Tag scans only move forward: rescanning from every unclosed opener is quadratic on
// a malformed page, and this parse blocks the main or runtime event loop.

/** Index of the `>` closing a tag, skipping any inside quoted attribute values; -1 when none closes it. */
function findTagEnd(html: string, from: number): number {
  let afterEquals = false
  let unquotedValue = false
  for (let i = from; i < html.length; i++) {
    const ch = html[i]
    if (ch === '>') {
      return i
    }
    const whitespace = /[\t\n\f\r ]/.test(ch)
    if (unquotedValue) {
      unquotedValue = !whitespace
    } else if (afterEquals) {
      if (ch === '"' || ch === "'") {
        const close = html.indexOf(ch, i + 1)
        if (close === -1) {
          return -1
        }
        i = close
        afterEquals = false
      } else if (!whitespace) {
        unquotedValue = true
        afterEquals = false
      }
    } else if (ch === '=') {
      afterEquals = true
    }
  }
  return -1
}

function findCommentEnd(html: string, from: number): number {
  if (html[from] === '>') {
    return from
  }
  if (html.startsWith('->', from)) {
    return from + 1
  }
  const close = /--!?>/g
  close.lastIndex = from
  return close.test(html) ? close.lastIndex - 1 : -1
}

function findScriptEnd(html: string, from: number): number {
  let escaped = false
  let doubleEscaped = false
  let dashes = 0
  const scriptTag = /<(\/?)script(?=[\t\n\f\r />])/iy
  for (let i = from; i < html.length; i++) {
    const ch = html[i]
    if (ch === '<') {
      if (!escaped && html.startsWith('<!--', i)) {
        escaped = true
        dashes = 2
        i += 3
        continue
      }
      scriptTag.lastIndex = i
      const tag = scriptTag.exec(html)
      if (tag) {
        if (tag[1] === '/') {
          if (!doubleEscaped) {
            return i
          }
          doubleEscaped = false
        } else if (escaped) {
          doubleEscaped = true
        }
        i = scriptTag.lastIndex - 1
      }
    } else if (ch === '>' && dashes >= 2) {
      escaped = false
      doubleEscaped = false
    }
    dashes = ch === '-' ? dashes + 1 : 0
  }
  return -1
}

function findRawTextEnd(html: string, name: string, from: number): number {
  if (name === 'script') {
    return findScriptEnd(html, from)
  }
  const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi')
  close.lastIndex = from
  return close.exec(html)?.index ?? -1
}

type HtmlTag = { attributesStart: number; end: number; contentEnd?: number }

/** Skip inert text before interpreting tag-shaped strings as page metadata. */
function* htmlTags(html: string, tagName: string): Generator<HtmlTag> {
  const wanted = tagName.toLowerCase()
  const open = /<!--|<!|<(\/?)([a-z][^\t\n\f\r />]*)/gi
  for (let match = open.exec(html); match; match = open.exec(html)) {
    if (match[0] === '<!--' || match[0] === '<!') {
      const end =
        match[0] === '<!--'
          ? findCommentEnd(html, open.lastIndex)
          : html.indexOf('>', open.lastIndex)
      if (end === -1) {
        return
      }
      open.lastIndex = end + 1
      continue
    }
    const name = match[2].toLowerCase()
    const attributesStart = open.lastIndex
    const end = findTagEnd(html, attributesStart)
    if (end === -1) {
      return
    }
    open.lastIndex = end + 1
    if (match[1] === '/') {
      continue
    }
    let contentEnd: number | undefined
    if (/^(script|style|title|textarea|xmp|iframe|noembed|noframes)$/.test(name)) {
      const closing = findRawTextEnd(html, name, open.lastIndex)
      if (closing === -1) {
        return
      }
      contentEnd = closing
      const closingEnd = findTagEnd(html, closing + name.length + 2)
      if (closingEnd === -1) {
        return
      }
      open.lastIndex = closingEnd + 1
    } else if (name === 'plaintext') {
      return
    }
    if (name === wanted) {
      yield { attributesStart, end, contentEnd }
    }
  }
}

/** Attributes of each `<tagName ...>` in document order; stops at the first unclosed tag. */
export function* htmlTagAttributes(html: string, tagName: string): Generator<Map<string, string>> {
  for (const { attributesStart, end } of htmlTags(html, tagName)) {
    const tag = html.slice(attributesStart, end)
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
  for (const { end, contentEnd } of htmlTags(html, 'title')) {
    return normalizeHtmlText(html.slice(end + 1, contentEnd)) || null
  }
  return null
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
