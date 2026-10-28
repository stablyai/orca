/** One list line, with its marker read and its nesting resolved against the lines around it. */
export type ParsedListItem = {
  indent: number
  ordered: boolean
  orderedNumber: number | null
  /** Whether the item's checkbox is ticked, or null when it is not a task at all. */
  task: boolean | null
  text: string
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
  const task = rawText.match(/^\[([ xX])\]\s+(.+)$/)
  const ordered = /^\d/.test(marker)
  return {
    indent: indentationWidth(match[1] ?? ''),
    ordered,
    orderedNumber: ordered ? Number.parseInt(marker, 10) : null,
    task: task ? task[1]!.toLowerCase() === 'x' : null,
    text: task ? task[2]! : rawText,
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
    index += 1
  }
  return { items: root.children, nextIndex: index }
}
