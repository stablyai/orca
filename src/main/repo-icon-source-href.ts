const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const LINK_ICON_OBJECT_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/iy

export function extractIconHref(source: string): string | null {
  const htmlHref = source.match(LINK_ICON_HTML_RE)?.[1]
  if (htmlHref !== undefined) {
    return htmlHref
  }
  let start = 0
  while (start <= source.length) {
    // Every suffix before the next closing brace sees the same candidate properties.
    LINK_ICON_OBJECT_RE.lastIndex = start
    const href = LINK_ICON_OBJECT_RE.exec(source)?.[1]
    if (href !== undefined) {
      return href
    }
    const closingBrace = source.indexOf('}', start)
    if (closingBrace === -1) {
      return null
    }
    start = closingBrace + 1
  }
  return null
}
