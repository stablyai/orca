import { codeFenceFor } from './markdown-code-fence'
import { escapeTableCell } from './markdown-table-rows'
import { inlineChildren, inlineMarkdown, textContent } from './html-inline-markdown'
import { holdsUnownedList, listMarkdown } from './html-list-markdown'

/**
 * A paragraph that carries a list, as the blocks it really holds: text, the list, then text.
 *
 * `insertUnorderedList` nests the `<ul>` inside the `<p>` it was given rather than replacing it —
 * measured on WebKit 26.4 and Chromium 147 both — and reading such a paragraph inline gave back its
 * own text with no marker, so a list the user typed did not survive a round trip. Structure decides
 * what a list is; the DOM is left as the engine made it.
 */
function blocksAroundLists(element: Element): string {
  const blocks: string[] = []
  let inline = ''
  const flushInline = () => {
    if (inline.trim()) {
      blocks.push(inline.trim())
    }
    inline = ''
  }
  for (const child of Array.from(element.childNodes)) {
    if (!(child instanceof Element)) {
      inline += inlineMarkdown(child)
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') {
      flushInline()
      blocks.push(listMarkdown(child, 0))
      continue
    }
    if (holdsUnownedList(child)) {
      flushInline()
      blocks.push(blocksAroundLists(child))
      continue
    }
    inline += inlineMarkdown(child)
  }
  flushInline()
  return blocks.filter(Boolean).join('\n\n')
}

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
    return holdsUnownedList(node) ? blocksAroundLists(node) : inlineChildren(node).trim()
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
