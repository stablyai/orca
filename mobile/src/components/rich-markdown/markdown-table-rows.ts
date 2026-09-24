/**
 * A table row's cells, on both halves of the round trip.
 *
 * The pipe is the row's only separator and also an ordinary character a cell may contain, so a
 * backslash is what tells the two apart. The writer escapes backslashes before pipes and the
 * reader undoes both, which is the one order under which a cell holding `\` and `|` survives.
 */

/** Whether the pipe ending `value` separates cells rather than belonging to one. */
function endsWithUnescapedPipe(value: string): boolean {
  if (!value.endsWith('|')) {
    return false
  }
  let backslashes = 0
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 0
}

/** Splits on the pipes no backslash claimed, carrying each escape into the cell it belongs to. */
function splitOnUnescapedPipes(value: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (char === '\\' && index + 1 < value.length) {
      cell += char + value[index + 1]!
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells
}

/** A table row's cells, with the optional leading and trailing pipes taken off. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const cells = splitOnUnescapedPipes(body)
  if (endsWithUnescapedPipe(body)) {
    cells.pop()
  }
  return cells.map((cell) => cell.trim().replace(/\\([\\|])/g, '$1'))
}

/** A cell's own backslashes and pipes, hidden from the row syntax that would split on them. */
export function escapeTableCell(cell: string): string {
  return cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/** The dashed row under a header, which is what makes the line above it a table rather than text. */
export function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}
