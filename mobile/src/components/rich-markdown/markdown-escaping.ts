/** The five characters that cannot appear literally in the document's own markup. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

// Resolve existing entities before re-escaping so &amp; cannot double-encode; range-check numeric code points to avoid throws, leaving unknown entities literal.
export function decodeMarkdownEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') {
      return '&'
    }
    if (lower === 'lt') {
      return '<'
    }
    if (lower === 'gt') {
      return '>'
    }
    if (lower === 'quot') {
      return '"'
    }
    if (lower === 'apos') {
      return "'"
    }
    if (lower.startsWith('#x')) {
      const hex = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(hex) && hex >= 0 && hex <= 0x10ffff ? String.fromCodePoint(hex) : match
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return match
  })
}

export function escapeHtml(value: string): string {
  return decodeMarkdownEntities(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/** An attribute value cannot carry a newline, which would end it in the markup being built. */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, ' ')
}

/** The one scheme a link or image in untrusted markdown may not carry. */
export function isSafeUrl(value: string | null | undefined): boolean {
  return !/^javascript:/i.test(String(value ?? '').trim())
}
