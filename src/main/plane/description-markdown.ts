/**
 * Plane stores rich text as HTML (`description_html`, `comment_html`). Agents
 * and list rows want plain text; writes want escaped HTML. This is Jira's ADF
 * problem in a far easier form — a tag soup rather than a node tree — so it
 * stays deliberately small instead of pulling in a parser.
 */

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function planeHtmlToText(html: string | null | undefined): string {
  if (!html) {
    return ''
  }
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(code))
    .replace(/&[a-z#0-9]+;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Wraps plain text as the sanitized HTML Plane's write endpoints expect. */
export function textToPlaneHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) {
    return ''
  }
  return paragraphs
    .map((block) => `<p>${escapeHtmlText(block).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

function safeCodePoint(code: string): string {
  const value = Number.parseInt(code, 10)
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return ''
  }
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}
