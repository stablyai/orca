import { scanHtmlTags } from './html-markup-scanner'

function readAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  // Names start after whitespace so a long unquoted run cannot backtrack from every offset.
  for (const [, name, double, single, bare] of tag.matchAll(
    /(?:^|\s)([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  )) {
    attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
  }
  return attributes
}

/** Attributes of each `<tagName ...>` in document order; stops at the first unclosed tag. */
export function* htmlTagAttributes(
  html: string,
  tagName: string,
  xml = false
): Generator<Map<string, string>> {
  for (const { attributesStart, end } of scanHtmlTags(
    html,
    new Set([tagName.toLowerCase()]),
    xml
  )) {
    yield readAttributes(html.slice(attributesStart, end))
  }
}

export function extractHtmlTitle(html: string, xml = false): string | null {
  for (const { end, contentEnd } of scanHtmlTags(html, new Set(['title']), xml)) {
    return normalizeHtmlText(html.slice(end + 1, contentEnd)) || null
  }
  return null
}

export function findIconHref(html: string, xml = false): string | null {
  for (const attributes of htmlTagAttributes(html, 'link', xml)) {
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attributes.get('href')
    if (rel.includes('icon') && href) {
      return decodeHtmlEntities(href)
    }
  }
  return null
}

export function readHtmlHead(
  html: string,
  xml = false
): {
  meta: Map<string, string>
  title: string | null
  iconHref: string | null
} {
  const meta = new Map<string, string>()
  let title: string | null = null
  let iconHref: string | null = null
  const wanted = new Set(['meta', 'title', 'link'])
  for (const { name, attributesStart, end, contentEnd } of scanHtmlTags(html, wanted, xml)) {
    if (name === 'title') {
      title = normalizeHtmlText(html.slice(end + 1, contentEnd)) || null
      wanted.delete('title')
      continue
    }
    const attributes = readAttributes(html.slice(attributesStart, end))
    if (name === 'link') {
      const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
      const href = attributes.get('href')
      if (rel.includes('icon') && href) {
        iconHref = decodeHtmlEntities(href)
        wanted.delete('link')
      }
      continue
    }
    const content = attributes.get('content')
    if (content === undefined) {
      continue
    }
    for (const key of [attributes.get('property'), attributes.get('name')]) {
      const property = key?.toLowerCase()
      if (property && !meta.has(property)) {
        meta.set(property, content)
      }
    }
  }
  return { meta, title, iconHref }
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

// HTML interprets these legacy numeric references as Windows-1252 characters.
const NUMERIC_ENTITY_REPLACEMENTS: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? '\ufffd'
        : String.fromCodePoint(NUMERIC_ENTITY_REPLACEMENTS[code] ?? code)
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}
