import { codeFenceFor } from './markdown-code-fence'

function renderedText(node: Node): string {
  if (node.nodeType === Node.COMMENT_NODE) {
    return ''
  }
  if (node instanceof Element) {
    if (node.tagName.toLowerCase() === 'br') {
      return '\n'
    }
    return Array.from(node.childNodes).map(renderedText).join('')
  }
  return node.textContent ?? ''
}

// A code span cannot hold a line break (readers turn it into a space), and a raw newline would end a table row or heading.
function inlineCodeText(node: Node): string {
  return textContent(node).replace(/\n/g, ' ')
}

/** A node's text with line breaks kept and browser-created non-breaking spaces turned back into spaces. */
export function textContent(node: Node): string {
  return renderedText(node).replace(/ /g, ' ')
}

function codeMarkdown(code: string): string {
  if (!code) {
    return ''
  }
  const delimiter = codeFenceFor(code, 1)
  const padding =
    code.startsWith('`') ||
    code.endsWith('`') ||
    (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code))
      ? ' '
      : ''
  return `${delimiter}${padding}${code}${padding}${delimiter}`
}

function isInlineCode(node: Node): boolean {
  return (
    node instanceof Element &&
    node.tagName.toLowerCase() === 'code' &&
    node.parentElement !== null &&
    node.parentElement.tagName.toLowerCase() !== 'pre'
  )
}

/**
 * How breaks inside the serialized run are spelled: `newline` for multi-line blocks, `cell` for table
 * cells and `item` for list items, which must stay on one source line. Items also turn sibling P/DIV
 * blocks (native Enter) into breaks.
 */
export type InlineLineBreaks = 'newline' | 'cell' | 'item'

export const LINE_BREAK_TAG = '<br />'

// Cells and items reopen `<br>` tokens as breaks, so escape only that opener in typed text; raw newlines render as spaces.
function singleLineText(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/<(?=[bB][rR][ \t]*\/?>)/g, '&lt;')
}

/** Where the trailing run of `<br />` tags (spaces between them included) starts, and its length. */
export function trailingLineBreaks(markdown: string): { start: number; count: number } {
  let start = markdown.length
  let count = 0
  for (;;) {
    let end = start
    while (end > 0 && /\s/.test(markdown[end - 1] ?? '')) {
      end -= 1
    }
    if (!markdown.endsWith(LINE_BREAK_TAG, end)) {
      return { start, count }
    }
    start = end - LINE_BREAK_TAG.length
    count += 1
  }
}

function markMarkdown(delimiter: string, inner: string, breaks: InlineLineBreaks): string {
  if (breaks === 'newline') {
    return `${delimiter}${inner}${delimiter}`
  }
  // Edge breaks go outside the delimiters: CommonMark readers leave `**a<br />**` unclosed.
  let start = 0
  while (inner.startsWith(LINE_BREAK_TAG, start)) {
    start += LINE_BREAK_TAG.length
  }
  let end = inner.length
  while (end > start && inner.endsWith(LINE_BREAK_TAG, end)) {
    end -= LINE_BREAK_TAG.length
  }
  const body = inner.slice(start, end)
  return body ? `${inner.slice(0, start)}${delimiter}${body}${delimiter}${inner.slice(end)}` : inner
}

function isCollapsibleText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && /^[ \t\r\n]*$/.test(node.textContent ?? '')
}

// The last node that draws something, so a trailing <br> is found through marks and wrappers.
function lastRenderedLeaf(node: Node): Node | null {
  for (let child = node.lastChild; child; child = child.previousSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!isCollapsibleText(child)) {
        return child
      }
      continue
    }
    if (!(child instanceof Element)) {
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (tag === 'br' || tag === 'img') {
      return child
    }
    if (tag === 'label' || tag === 'ul' || tag === 'ol') {
      continue
    }
    const leaf = lastRenderedLeaf(child)
    if (leaf) {
      return leaf
    }
  }
  return null
}

function endsWithLineBreak(node: Node): boolean {
  const leaf =
    node instanceof Element && node.tagName.toLowerCase() === 'br' ? node : lastRenderedLeaf(node)
  return leaf instanceof Element && leaf.tagName.toLowerCase() === 'br'
}

// Serialize task label as empty: checkbox chrome is replaced by list writer’s Markdown marker.
export function inlineMarkdown(
  node: Node | null | undefined,
  breaks: InlineLineBreaks = 'newline'
): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return breaks === 'newline' ? textContent(node) : singleLineText(textContent(node))
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') {
    return breaks === 'newline' ? '\n' : LINE_BREAK_TAG
  }
  if (tag === 'strong' || tag === 'b') {
    return markMarkdown('**', inlineChildren(node, breaks), breaks)
  }
  if (tag === 'em' || tag === 'i') {
    return markMarkdown('*', inlineChildren(node, breaks), breaks)
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return markMarkdown('~~', inlineChildren(node, breaks), breaks)
  }
  if (isInlineCode(node)) {
    return codeMarkdown(inlineCodeText(node))
  }
  if (tag === 'a') {
    return `[${inlineChildren(node, breaks)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node, breaks)
}

export function inlineChildren(element: Element, breaks: InlineLineBreaks = 'newline'): string {
  return inlineNodesMarkdown(element.childNodes, breaks)
}

// Adjacent text nodes are joined before escaping so a `<br>` typed across a node split stays literal.
export function inlineNodesMarkdown(
  nodes: Iterable<Node>,
  breaks: InlineLineBreaks = 'newline'
): string {
  const parts: string[] = []
  let code = ''
  let text = ''
  let whitespace = ''
  let emitted = false
  let previousBlock = false
  let previousEndsWithBreak = false
  const emit = (markdown: string, block: boolean, endsWithBreak: boolean) => {
    if (block || previousBlock) {
      if (emitted && !previousEndsWithBreak) {
        parts.push(LINE_BREAK_TAG)
      }
    } else if (whitespace) {
      parts.push(whitespace)
    }
    whitespace = ''
    parts.push(markdown)
    emitted = true
    previousBlock = block
    previousEndsWithBreak = endsWithBreak
  }
  const flushText = () => {
    if (!text) {
      return
    }
    const value = text.replace(/\u00a0/g, ' ')
    if (breaks === 'newline') {
      emit(value, false, false)
    } else if (breaks === 'item' && /^[ \t\r\n]*$/.test(text)) {
      // Formatting whitespace beside a block draws nothing; between inline runs it is a space.
      whitespace += singleLineText(value)
    } else {
      emit(singleLineText(value), false, false)
    }
    text = ''
  }
  const flushCode = () => {
    if (code) {
      emit(codeMarkdown(code), false, false)
      code = ''
    }
  }
  for (const child of nodes) {
    if (isInlineCode(child)) {
      flushText()
      code += inlineCodeText(child)
      continue
    }
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) {
        flushCode()
        text += child.textContent
      }
      continue
    }
    const block = breaks === 'item' && child instanceof Element && /^(p|div)$/i.test(child.tagName)
    // Spaces at a block's edges collapse, so they stay out of the line they would now share.
    const markdown = block ? inlineMarkdown(child, breaks).trim() : inlineMarkdown(child, breaks)
    if (!markdown) {
      continue
    }
    flushText()
    flushCode()
    emit(markdown, block, breaks === 'item' && endsWithLineBreak(child))
  }
  flushText()
  flushCode()
  if (whitespace && !previousBlock) {
    parts.push(whitespace)
  }
  return parts.join('')
}
