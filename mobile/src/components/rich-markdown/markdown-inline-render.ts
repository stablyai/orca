import {
  createRawMarkdownCodeSpanScanner,
  type MarkdownCodeSpanScanner
} from '../../../../src/shared/markdown-code-span-runs'
import {
  decodeMarkdownEntities,
  escapeAttr,
  escapeHtml,
  escapeLiteralHtml,
  isSafeUrl
} from './markdown-escaping'
import { routeMarkdownHref } from '../markdown-href-routing'

/** Holds a workspace image's markdown path; the page resolves it, so the host loads `src` instead. */
export const WORKSPACE_IMAGE_PATH_ATTRIBUTE = 'data-workspace-path'

function imageSourceAttribute(href: string): string {
  const name =
    routeMarkdownHref(decodeMarkdownEntities(href)).kind === 'file'
      ? WORKSPACE_IMAGE_PATH_ATTRIBUTE
      : 'src'
  return `${name}="${escapeAttr(href)}"`
}

// Build global exec regex per recursive call: shared lastIndex would leak between nested parses. Escape text between recognized inline forms.
// Table cells and list items opt in to attribute-free `<br>` tokens, the only way they hold a line break.
export function renderInline(text: string, allowLineBreaks = false): string {
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`+|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+|<[bB][rR][ \t]*\/?>)/g
  let codeSpans: MarkdownCodeSpanScanner | undefined
  let output = ''
  let lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    output += escapeHtml(text.slice(lastIndex, match.index))
    const token = match[0]
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (token.startsWith('<')) {
      output += allowLineBreaks ? '<br />' : escapeHtml(token)
    } else if (image && isSafeUrl(image[2])) {
      output += `<img ${imageSourceAttribute(image[2]!)} alt="${escapeAttr(image[1] ?? '')}" />`
    } else if (link && isSafeUrl(link[2])) {
      output += `<a href="${escapeAttr(link[2]!)}">${renderInline(link[1]!, allowLineBreaks)}</a>`
    } else if (/^https?:\/\//i.test(token)) {
      output += `<a href="${escapeAttr(token)}">${escapeHtml(token)}</a>`
    } else if (token.startsWith('`')) {
      codeSpans ??= createRawMarkdownCodeSpanScanner(text)
      const spanEnd = codeSpans.findSpanEnd(match.index)
      if (spanEnd === null) {
        output += escapeHtml(token)
      } else {
        let code = text.slice(pattern.lastIndex, spanEnd - token.length).replace(/\r\n?|\n/g, ' ')
        if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) {
          code = code.slice(1, -1)
        }
        output += `<code>${escapeLiteralHtml(code)}</code>`
        pattern.lastIndex = spanEnd
      }
    } else if (token.startsWith('~~')) {
      output += `<s>${renderInline(token.slice(2, -2), allowLineBreaks)}</s>`
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output += `<strong>${renderInline(token.slice(2, -2), allowLineBreaks)}</strong>`
    } else {
      output += `<em>${renderInline(token.slice(1, -1), allowLineBreaks)}</em>`
    }
    lastIndex = pattern.lastIndex
    match = pattern.exec(text)
  }
  return output + escapeHtml(text.slice(lastIndex))
}
