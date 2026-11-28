import { decodeHtmlEntities } from '../../../shared/text/html-entities'
import { htmlStartTagEnd } from '../../../shared/text/html-start-tag-end'

// Tag scans only move forward: rescanning from every unclosed opener is quadratic on
// a malformed page, and this parse blocks the main or runtime event loop.

/** Attributes of each `<tagName ...>` in document order; stops at the first unclosed tag. */
export function* htmlTagAttributes(html: string, tagName: string): Generator<Map<string, string>> {
  const open = new RegExp(`<${tagName}\\b`, 'gi')
  while (open.test(html)) {
    const end = htmlStartTagEnd(html, open.lastIndex)
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
