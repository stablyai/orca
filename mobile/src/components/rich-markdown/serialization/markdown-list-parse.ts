import { closesFence, openingFence } from './markdown-code-fence'
import { isTableSeparator } from './markdown-table-rows'

/** One list line, with its marker read and its nesting resolved against the lines around it. */
export type ParsedListItem = {
  indent: number
  ordered: boolean
  orderedNumber: number | null
  /** Whether the item's checkbox is ticked, or null when it is not a task at all. */
  task: boolean | null
  text: string
  /** The item's own lines, first line included, when they hold a fenced code block. */
  blockSource?: string
  children: ParsedListItem[]
}

/** A tab indents as far as four spaces, so mixed indentation still nests the way it looks. */
export function indentationWidth(value: string): number {
  return value.replace(/\t/g, '    ').length
}

export function parseListLine(line: string): ParsedListItem | null {
  const match = line.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+(.+)$/)
  if (!match) {
    return null
  }
  const marker = match[2] ?? ''
  const rawText = match[3] ?? ''
  const task = rawText.match(/^\[([ xX])\](?:\s+(.*))?$/)
  const ordered = /^\d/.test(marker)
  return {
    indent: indentationWidth(match[1] ?? ''),
    ordered,
    orderedNumber: ordered ? Number.parseInt(marker, 10) : null,
    task: task ? task[1]!.toLowerCase() === 'x' : null,
    text: task ? (task[2] ?? '') : rawText,
    children: []
  }
}

/** Which of the three list shapes an item belongs to; a run of one kind becomes one list. */
export function listKind(item: ParsedListItem): 'task' | 'ol' | 'ul' {
  if (item.task !== null) {
    return 'task'
  }
  return item.ordered ? 'ol' : 'ul'
}

function removeIndentation(line: string, width: number): string {
  let index = 0
  let removed = 0
  while (index < line.length && removed < width) {
    if (line[index] === ' ') {
      removed += 1
    } else if (line[index] === '\t') {
      removed += 4
    } else {
      break
    }
    index += 1
  }
  return ' '.repeat(Math.max(0, removed - width)) + line.slice(index)
}

// Headings, quotes, rules and tables end the item's blocks, so they keep reading as they did before.
function endsItemBlocks(content: string, next: string): boolean {
  const line = content.trimStart()
  return (
    /^(#{1,6}\s|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line) ||
    (line.includes('|') && isTableSeparator(next))
  )
}

// Indented continuation lines join the item only when they hold a fence; other items keep one-line reading.
function listItemBlocks(
  lines: string[],
  startIndex: number,
  item: ParsedListItem
): { source: string; nextIndex: number } | null {
  if (
    /^\[[ xX]\]$/.test(item.text) ||
    (item.task !== null && (!item.text.trim() || openingFence(item.text)))
  ) {
    return null
  }
  const marker = (lines[startIndex] ?? '').match(/^(\s*)(?:[-*+]|\d+[.)])([ \t]+)/)
  if (!marker) {
    return null
  }
  const width = indentationWidth(marker[0])
  const body = [item.text]
  let fence = openingFence(item.text)
  let hasCode = fence !== null
  let index = startIndex + 1
  let end = index
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      body.push(fence ? removeIndentation(line, width) : '')
      index += 1
      if (fence) {
        end = index
      }
      continue
    }
    if (indentationWidth(line.match(/^[ \t]*/)?.[0] ?? '') < width) {
      break
    }
    const content = removeIndentation(line, width)
    if (
      !fence &&
      (parseListLine(line) ||
        endsItemBlocks(content, removeIndentation(lines[index + 1] ?? '', width)))
    ) {
      break
    }
    body.push(content)
    if (fence) {
      if (closesFence(content, fence.fence)) {
        fence = null
      }
    } else {
      fence = openingFence(content)
      hasCode ||= fence !== null
    }
    index += 1
    end = index
  }
  if (!hasCode) {
    return null
  }
  return { source: body.slice(0, end - startIndex).join('\n'), nextIndex: end }
}

// Parse contiguous list run with stack: indent can drop several levels and caller needs end index to resume block parsing.
export function parseListTree(
  lines: string[],
  startIndex: number
): { items: ParsedListItem[]; nextIndex: number } {
  type ListLevel = { indent: number; children: ParsedListItem[] }
  const root: ListLevel = { indent: -1, children: [] }
  const stack: ListLevel[] = [root]
  let index = startIndex
  while (index < lines.length) {
    const item = parseListLine(lines[index] ?? '')
    if (!item) {
      break
    }
    while (stack.length > 1 && item.indent <= stack[stack.length - 1]!.indent) {
      stack.pop()
    }
    stack[stack.length - 1]!.children.push(item)
    stack.push(item)
    const blocks = listItemBlocks(lines, index, item)
    if (blocks) {
      item.blockSource = blocks.source
    }
    index = blocks?.nextIndex ?? index + 1
  }
  return { items: root.children, nextIndex: index }
}
