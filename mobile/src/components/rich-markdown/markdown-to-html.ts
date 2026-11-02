import { escapeAttr, escapeLiteralHtml } from './markdown-escaping'
import { renderInline } from './markdown-inline-render'
import { renderListItems } from './markdown-list-render'
import { parseListTree } from './markdown-list-parse'
import { closesFence, openingFence } from './markdown-code-fence'
import { isTableSeparator, splitTableRow } from './markdown-table-rows'
import { blockMarkdown } from './html-block-markdown'
import type { RichMarkdownEditorScope } from './document-scope'

/** Whether a line opens a block of its own, which is what ends the paragraph being gathered. */
export function isBlockStart(line: string): boolean {
  return /^(```|#{1,6}\s+|>\s?|\s*(?:[-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(line)
}

// Use quote blocks only when they save the source or what the literal paragraph saves; the list reader drops continuation and lazy lines.
function quoteMarkup(probe: () => Element, quote: string[], structured: string): string {
  const literal = `<p>${renderInline(quote.join('\n').trim()).replace(/\n/g, '<br />')}</p>`
  if (structured === literal) {
    return structured
  }
  const element = probe()
  element.innerHTML = structured
  const structuredMarkdown = blockMarkdown(element)
  if (structuredMarkdown.replace(/^> /gm, '').trim() === quote.join('\n').trim()) {
    return structured
  }
  element.innerHTML = literal
  return blockMarkdown(element) === structuredMarkdown ? structured : literal
}

// Read fenced/table/list blocks by their own consumed line runs, not flat replacements; empty source still needs paragraph for placeholder.
// Inside a list item paragraphs read `<br>` tokens, the item writer's only line-break spelling.
export function markdownToHtml(
  scope: RichMarkdownEditorScope,
  markdown: string,
  insideListItem = false
): string {
  let lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let html: string[] = []
  let index = 0
  const parents: { lines: string[]; html: string[]; index: number }[] = []
  let quoteProbe: Element | null = null
  // Inert document so probed images and links never load.
  const probe = () =>
    (quoteProbe ??= scope
      .getDocument()
      .implementation.createHTMLDocument('')
      .createElement('blockquote'))
  while (index < lines.length || parents.length > 0) {
    if (index >= lines.length) {
      const parent = parents.pop()
      if (!parent) {
        break
      }
      const markup = quoteMarkup(probe, lines, html.join('\n') || '<p><br /></p>')
      lines = parent.lines
      html = parent.html
      index = parent.index
      html.push(`<blockquote>${markup}</blockquote>`)
      continue
    }
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    const fence = openingFence(line)
    if (fence) {
      index += 1
      const code: string[] = []
      while (index < lines.length && !closesFence(lines[index] ?? '', fence.fence)) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      html.push(
        `<pre data-language="${escapeAttr(fence.language)}"><code>${escapeLiteralHtml(code.join('\n'))}</code></pre>`
      )
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr />')
      index += 1
      continue
    }
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      const headers = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (
        index < lines.length &&
        (lines[index] ?? '').includes('|') &&
        (lines[index] ?? '').trim()
      ) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      const head = headers.map((cell) => `<th>${renderInline(cell, true)}</th>`).join('')
      const body = rows
        .map(
          (row) =>
            `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] ?? '', true)}</td>`).join('')}</tr>`
        )
        .join('')
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]!.length
      html.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`)
      index += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      parents.push({ lines, html, index })
      lines = quote
      html = []
      index = 0
      continue
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const list = parseListTree(lines, index)
      // Empty marker produces no list item and no index progress; fall through as text instead of continuing forever.
      if (list.nextIndex > index) {
        html.push(
          renderListItems(scope, list.items, (content) => markdownToHtml(scope, content, true))
        )
        index = list.nextIndex
        continue
      }
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !isBlockStart(lines[index] ?? '') &&
      !(
        index + 1 < lines.length &&
        (lines[index] ?? '').includes('|') &&
        isTableSeparator(lines[index + 1] ?? '')
      )
    ) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    if (paragraph.length === 0) {
      // Consume text when isBlockStart admits line no reader accepts (# /- /invalid fence language); otherwise loop never advances.
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    html.push(
      `<p>${renderInline(paragraph.join('\n'), insideListItem).replace(/\n/g, '<br />')}</p>`
    )
  }
  return html.join('\n') || '<p class="is-empty"><br /></p>'
}
