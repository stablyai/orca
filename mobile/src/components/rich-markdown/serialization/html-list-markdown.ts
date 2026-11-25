import { codeBlockMarkdown } from './html-code-block-markdown'
import { inlineNodesMarkdown, LINE_BREAK_TAG, trailingLineBreaks } from './html-inline-markdown'
import { openingFence } from './markdown-code-fence'

function itemInlineMarkdown(nodes: Iterable<Node>): string {
  const markdown = inlineNodesMarkdown(nodes, 'item')
    .replace(/\r\n?|\n/g, ' ')
    .trim()
  // A lone trailing <br> is the browser's invisible caret placeholder; a run of two draws an empty line.
  const trailing = trailingLineBreaks(markdown)
  return trailing.count === 1 && trailing.start > 0
    ? markdown.slice(0, trailing.start).trimEnd()
    : markdown
}

// Remove checkbox label/nested lists on clone only: live checkbox must remain, nested lists serialize at own indentation.
export function listItemText(item: Element): string {
  const clone = item.cloneNode(true)
  // `cloneNode` is typed as returning a `Node`; an element's deep copy is an element.
  if (!(clone instanceof Element)) {
    return ''
  }
  clone.querySelectorAll('label').forEach((label) => label.remove())
  clone.querySelectorAll('ul, ol').forEach((list) => list.remove())
  return itemInlineMarkdown(clone.childNodes)
}

function hasOwnedCodeBlock(item: Element): boolean {
  const pending = Array.from(item.children)
  for (let node = pending.pop(); node; node = pending.pop()) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'pre') {
      return true
    }
    if (tag === 'p' || tag === 'div') {
      pending.push(...Array.from(node.children))
    }
  }
  return false
}

// An item's paragraphs and code blocks as Markdown lines, or null when the one-line writer applies.
// Headings, quotes, tables and rules also fall back to that writer rather than lose their markers here.
function listItemCodeBlocks(item: Element, isTask: boolean): string | null {
  if (!hasOwnedCodeBlock(item)) {
    return null
  }
  let body = ''
  let previousCode: boolean | null = null
  let firstCode = false
  // A fence needs no blank line beside it, so tight README items stay tight; paragraphs need one.
  const push = (markdown: string, code: boolean) => {
    if (previousCode === null) {
      firstCode = code
    } else {
      body += previousCode || code ? '\n' : '\n\n'
    }
    body += markdown
    previousCode = code
  }
  let inline: Node[] = []
  let nested = false
  const flush = () => {
    const markdown = itemInlineMarkdown(inline)
    inline = []
    // A paragraph holding only the caret placeholder saves as nothing, as it does outside lists.
    if (markdown && markdown !== LINE_BREAK_TAG) {
      push(markdown, false)
    }
  }
  const pending: (Node | null)[] = []
  const pushChildren = (parent: Node) => {
    for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
      const child = parent.childNodes.item(index)
      if (child) {
        pending.push(child)
      }
    }
  }
  pushChildren(item)
  while (pending.length) {
    const node = pending.pop()
    if (!node) {
      flush()
      continue
    }
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'ul' || tag === 'ol' || tag === 'label') {
        nested ||= tag !== 'label'
        continue
      }
      if (nested || /^(h[1-6]|blockquote|table|hr)$/.test(tag)) {
        return null
      }
      if (tag === 'pre') {
        const language = node.getAttribute('data-language') ?? ''
        if (openingFence(`\`\`\`${language}`)?.language !== language) {
          return null
        }
        flush()
        push(codeBlockMarkdown(node), true)
        continue
      }
      if (tag === 'p' || tag === 'div') {
        flush()
        pending.push(null)
        pushChildren(node)
        continue
      }
    }
    if (nested && node.textContent?.trim()) {
      return null
    }
    inline.push(node)
  }
  flush()
  if (!body) {
    return null
  }
  // The task reader cannot open a fence after the checkbox, so an empty first line holds the place.
  return isTask && firstCode ? `${LINE_BREAK_TAG}\n${body}` : body
}

/** The lists directly inside an item, rather than every list anywhere beneath it. */
export function directNestedLists(item: Element): Element[] {
  return Array.from(item.querySelectorAll('ul, ol')).filter((list) => list.closest('li') === item)
}

// Non-li-owned lists are standalone blocks wherever engine placed them, including inside p; li-owned nested lists serialize at own indentation.
export function holdsUnownedList(element: Element): boolean {
  return Array.from(element.querySelectorAll('ul, ol')).some((list) => list.closest('li') === null)
}

// An empty task saves as a bare `- [ ]` rather than leaving trailing whitespace on its line.
function itemLine(prefix: string, text: string, isTask: boolean): string {
  return isTask && !text ? prefix.trimEnd() : prefix + text
}

// Indent two spaces per list level; prefer markup item number over position to preserve pasted/split browser renumbering.
export function listMarkdown(element: Element, depth: number): string {
  const tag = element.tagName.toLowerCase()
  const isTask = element.getAttribute('data-type') === 'taskList'
  const parsedStart = tag === 'ol' ? Number.parseInt(element.getAttribute('start') ?? '1', 10) : 1
  const orderedStart = Number.isFinite(parsedStart) ? parsedStart : 1
  const indent = '  '.repeat(depth)
  return Array.from(element.children)
    .map((item, index) => {
      if (item.tagName.toLowerCase() !== 'li') {
        return ''
      }
      let marker: string
      if (isTask) {
        const input = item.querySelector<HTMLInputElement>('input[type="checkbox"]')
        marker = `- [${input && input.checked ? 'x' : ' '}] `
      } else {
        // `||` rather than `??`: an empty attribute is no number, and the next source answers.
        const listNumber = item.getAttribute('data-list-number') || item.getAttribute('value')
        marker = tag === 'ol' ? `${listNumber || orderedStart + index}. ` : '- '
      }
      const blocks = listItemCodeBlocks(item, isTask)
      const continuation = indent + ' '.repeat(tag === 'ol' ? marker.length : 2)
      // Blank separator lines stay empty; content lines take the item's continuation indent.
      const line = blocks
        ? indent +
          marker +
          blocks
            .split('\n')
            .map((text, lineIndex) => (lineIndex === 0 || !text ? text : continuation + text))
            .join('\n')
        : itemLine(indent + marker, listItemText(item), isTask)
      // Children of a wide ordered marker start at its content column, or readers end the item.
      const nestedIndent = blocks
        ? ' '.repeat(Math.max(0, continuation.length - indent.length - 2))
        : ''
      const nested = directNestedLists(item)
        .map((list) => listMarkdown(list, depth + 1))
        .filter(Boolean)
        .map((markdown) => (nestedIndent ? markdown.replace(/^(?=.)/gm, nestedIndent) : markdown))
        .join('\n')
      return nested ? `${line}\n${nested}` : line
    })
    .filter(Boolean)
    .join('\n')
}
