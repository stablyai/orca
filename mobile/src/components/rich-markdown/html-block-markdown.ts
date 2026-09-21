import { codeFenceFor } from './markdown-code-fence'
import { escapeTableCell } from './markdown-table-rows'
import { inlineChildren, inlineMarkdown, textContent } from './html-inline-markdown'
import { listMarkdown } from './html-list-markdown'

/**
 * One top-level node of the editable surface as a markdown block.
 *
 * Anything with no block of its own — a stray `div`, an element the browser inserted — serializes
 * as its inline content, so an edit never loses text to a tag this reader does not know.
 */
export function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node).trim()
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) {
    return `${'#'.repeat(Number(tag.slice(1)))} ${inlineChildren(node).trim()}`
  }
  if (tag === 'p' || tag === 'div') {
    return inlineChildren(node).trim()
  }
  if (tag === 'blockquote') {
    return inlineChildren(node)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
  }
  if (tag === 'pre') {
    const language = node.getAttribute('data-language') ?? ''
    const code = textContent(node.querySelector('code') ?? node).replace(/\n+$/g, '')
    const fence = codeFenceFor(code)
    return `${fence}${language}\n${code}\n${fence}`
  }
  if (tag === 'ul' || tag === 'ol') {
    return listMarkdown(node, 0)
  }
  if (tag === 'table') {
    const rows = Array.from(node.querySelectorAll('tr'))
    if (rows.length === 0) {
      return ''
    }
    const cellsFor = (row: Element) =>
      Array.from(row.children).map((cell) => escapeTableCell(inlineChildren(cell).trim()))
    const headers = cellsFor(rows[0]!)
    const bodyRows = rows.slice(1).map(cellsFor)
    const separator = headers.map(() => '---').join(' | ')
    const body = bodyRows.length
      ? `\n${bodyRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`
      : ''
    return `| ${headers.join(' | ')} |\n| ${separator} |${body}`
  }
  if (tag === 'hr') {
    return '---'
  }
  if (tag === 'img') {
    return inlineMarkdown(node)
  }
  return inlineChildren(node).trim()
}
