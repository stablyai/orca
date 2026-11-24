import { codeBlockMarkdown } from './html-code-block-markdown'
import { escapeTableCell } from './markdown-table-rows'
import {
  inlineChildren,
  inlineMarkdown,
  inlineNodesMarkdown,
  textContent,
  trailingLineBreaks
} from './html-inline-markdown'
import { holdsUnownedList, listMarkdown } from './html-list-markdown'

function* paragraphCodeNodes(element: Element): Generator<Node | null> {
  const pending: (Node | null)[] = []
  const pushChildren = (parent: Node) => {
    for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
      const child = parent.childNodes.item(index)
      if (child) {
        pending.push(child)
      }
    }
  }
  pushChildren(element)
  while (pending.length) {
    const node = pending.pop() ?? null
    if (node instanceof Element && /^(p|div)$/i.test(node.tagName)) {
      yield null
      pending.push(null)
      pushChildren(node)
    } else {
      yield node
    }
  }
}

function hasParagraphCodeBlock(element: Element): boolean {
  for (const node of paragraphCodeNodes(element)) {
    if (node instanceof Element && node.tagName.toLowerCase() === 'pre') {
      return true
    }
  }
  return false
}

// WebKit 26.4/Chromium 147 insertUnorderedList nests ul inside p; serialize surrounding inline runs and list as separate blocks or typed list markers vanish. Leave DOM unchanged.
function blocksAroundLists(element: Element, preserveCode = false): string {
  const blocks: string[] = []
  let inline: Node[] = []
  const flushInline = () => {
    const markdown = inlineNodesMarkdown(inline).trim()
    if (markdown) {
      blocks.push(markdown)
    }
    inline = []
  }
  const containsLists = !preserveCode || holdsUnownedList(element)
  const nodes = preserveCode ? paragraphCodeNodes(element) : Array.from(element.childNodes)
  for (const child of nodes) {
    if (child === null) {
      flushInline()
      continue
    }
    if (!(child instanceof Element)) {
      inline.push(child)
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (preserveCode && tag === 'pre') {
      flushInline()
      blocks.push(blockMarkdown(child))
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      flushInline()
      blocks.push(listMarkdown(child, 0))
      continue
    }
    if (containsLists && holdsUnownedList(child)) {
      flushInline()
      blocks.push(blocksAroundLists(child))
      continue
    }
    inline.push(child)
  }
  flushInline()
  return blocks.filter(Boolean).join('\n\n')
}

function quoteMarkdown(element: Element): string {
  const blocks: string[] = []
  let inline: Node[] = []
  const flushInline = () => {
    const markdown = inlineNodesMarkdown(inline).trim()
    if (markdown) {
      blocks.push(markdown)
    }
    inline = []
  }
  for (const child of element.childNodes) {
    if (
      child instanceof Element &&
      /^(p|div|h[1-6]|blockquote|pre|ul|ol|table|hr)$/.test(child.tagName.toLowerCase())
    ) {
      flushInline()
      const markdown = blockMarkdown(child)
      if (markdown.trim()) {
        blocks.push(markdown)
      }
    } else {
      inline.push(child)
    }
  }
  flushInline()
  return blocks
    .join('\n\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function headingCodeMarkdown(element: Element): string {
  const prefix = '#'.repeat(Number(element.tagName.slice(1)))
  const blocks: string[] = []
  let inline: Node[] = []
  const flushInline = () => {
    const markdown = inlineNodesMarkdown(inline).trim()
    if (markdown) {
      blocks.push(`${prefix} ${markdown}`)
    }
    inline = []
  }
  for (const child of Array.from(element.childNodes)) {
    if (child instanceof Element && child.tagName.toLowerCase() === 'pre') {
      flushInline()
      blocks.push(blockMarkdown(child))
    } else {
      inline.push(child)
    }
  }
  flushInline()
  return blocks.join('\n\n')
}

// A lone trailing <br> is the browser's caret placeholder (a cleared cell keeps one); a run of two is authored spacing.
function tableCellMarkdown(cell: Element): string {
  const markdown = inlineChildren(cell, 'cell')
    .replace(/\r\n?|\n/g, ' ')
    .trim()
  const trailing = trailingLineBreaks(markdown)
  return trailing.count === 1 ? markdown.slice(0, trailing.start).trimEnd() : markdown
}

// Unknown block elements serialize inline content so browser-created tags cannot lose user text.
export function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node).trim()
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) {
    if (Array.from(node.children).some((child) => child.tagName.toLowerCase() === 'pre')) {
      return headingCodeMarkdown(node)
    }
    return `${'#'.repeat(Number(tag.slice(1)))} ${inlineChildren(node).trim()}`
  }
  if (tag === 'p' || tag === 'div') {
    if (node.querySelector('pre') && hasParagraphCodeBlock(node)) {
      return blocksAroundLists(node, true)
    }
    return holdsUnownedList(node) ? blocksAroundLists(node) : inlineChildren(node).trim()
  }
  if (tag === 'blockquote') {
    return quoteMarkdown(node)
  }
  if (tag === 'pre') {
    return codeBlockMarkdown(node)
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
      Array.from(row.children).map((cell) => escapeTableCell(tableCellMarkdown(cell)))
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
