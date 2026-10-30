import { escapeAttr, escapeHtml, isSafeUrl } from './markdown-escaping'

// Build global exec regex per recursive call: shared lastIndex would leak between nested parses. Escape text between recognized inline forms.
export function renderInline(text: string): string {
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+)/g
  let output = ''
  let lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    output += escapeHtml(text.slice(lastIndex, match.index))
    const token = match[0]
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (image && isSafeUrl(image[2])) {
      output += `<img src="${escapeAttr(image[2]!)}" alt="${escapeAttr(image[1] ?? '')}" />`
    } else if (link && isSafeUrl(link[2])) {
      output += `<a href="${escapeAttr(link[2]!)}">${renderInline(link[1]!)}</a>`
    } else if (/^https?:\/\//i.test(token)) {
      output += `<a href="${escapeAttr(token)}">${escapeHtml(token)}</a>`
    } else if (token.startsWith('`')) {
      output += `<code>${escapeHtml(token.slice(1, -1))}</code>`
    } else if (token.startsWith('~~')) {
      output += `<s>${renderInline(token.slice(2, -2))}</s>`
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output += `<strong>${renderInline(token.slice(2, -2))}</strong>`
    } else {
      output += `<em>${renderInline(token.slice(1, -1))}</em>`
    }
    lastIndex = pattern.lastIndex
    match = pattern.exec(text)
  }
  return output + escapeHtml(text.slice(lastIndex))
}
