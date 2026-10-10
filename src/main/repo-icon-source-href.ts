const LINK_START_RE = /<link\b/gi
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/iy
const LINK_ICON_OBJECT_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/iy

function extractHtmlIconHref(source: string): string | null {
  LINK_START_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINK_START_RE.exec(source))) {
    LINK_ICON_HTML_RE.lastIndex = match.index
    const href = LINK_ICON_HTML_RE.exec(source)?.[1]
    if (href !== undefined) {
      return href
    }
    // Later link starts before the same closing angle see only a subset of these attributes.
    const closingAngle = source.indexOf('>', LINK_START_RE.lastIndex)
    if (closingAngle === -1) {
      return null
    }
    LINK_START_RE.lastIndex = closingAngle + 1
  }
  return null
}

export function extractIconHref(source: string): string | null {
  const htmlHref = extractHtmlIconHref(source)
  if (htmlHref !== null) {
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
