import {
  parseTomlKeyPath,
  parseTomlTableHeaderPath
} from '../../codex/configuration/toml/config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../../codex/configuration/toml/config-toml-line-scan'

const isBlank = (line: string): boolean => line.trim() === ''
const isCommentOrBlank = (line: string): boolean => isBlank(line) || line.trim().startsWith('#')

/**
 * Removes the `<root>.<name>` servers' tables, dotted keys and inline entries as a text splice, so
 * every other byte (comments, order, CRLF) stays. Comments just above the next table stay with it.
 * Null when a server lives inside an inline `<root> = { … }` table, which no line splice can edit.
 */
export function removeTomlMcpServers(
  text: string,
  root: string,
  names: ReadonlySet<string>
): string | null {
  // Each line keeps its terminator, so joining the kept lines restores the bytes exactly.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const bare = lines.map((line) => line.replace(/\r?\n$/, ''))
  const removed: boolean[] = lines.map(() => false)
  let table: string[] | null = []
  let tableRemoved = false
  let state = createTomlLineScanState()
  for (let index = 0; index < lines.length; index++) {
    const line = bare[index]!
    if (!isTomlStructuralLine(state)) {
      removed[index] = tableRemoved
      state = updateTomlLineScanState(state, line)
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      if (tableRemoved) {
        // Comments and blanks right above the next table belong to it.
        for (
          let back = index - 1;
          back >= 0 && removed[back] && isCommentOrBlank(bare[back]!);
          back--
        ) {
          removed[back] = false
        }
      }
      table = parseTomlTableHeaderPath(header)?.segments ?? null
      tableRemoved = table?.[0] === root && names.has(table[1] ?? '')
      removed[index] = tableRemoved
      state = updateTomlLineScanState(state, line)
      continue
    }
    if (tableRemoved) {
      removed[index] = true
      state = updateTomlLineScanState(state, line)
      continue
    }
    const key = parseTomlKeyPath(line)
    const path =
      table && key && line.slice(key.end).trimStart().startsWith('=')
        ? [...table, ...key.segments]
        : []
    if (path[0] === root && path.length === 1) {
      return null
    }
    const own = path[0] === root && names.has(path[1] ?? '')
    // A value can run over several lines (a multiline string or array); remove all of them.
    state = updateTomlLineScanState(state, line)
    removed[index] = own
    while (own && !isTomlStructuralLine(state) && index + 1 < lines.length) {
      index += 1
      removed[index] = true
      state = updateTomlLineScanState(state, bare[index]!)
    }
  }
  if (tableRemoved) {
    for (let back = lines.length - 1; back >= 0 && removed[back] && isBlank(bare[back]!); back--) {
      removed[back] = false
    }
  }
  absorbBlankLinesAboveRemovedRuns(bare, removed)
  return lines.filter((_, index) => !removed[index]).join('')
}

// A removed run between blank lines (or at the end) would leave a double gap behind.
function absorbBlankLinesAboveRemovedRuns(bare: readonly string[], removed: boolean[]): void {
  for (let index = 0; index < bare.length; index++) {
    if (!removed[index] || (index > 0 && removed[index - 1])) {
      continue
    }
    let end = index
    while (end + 1 < bare.length && removed[end + 1]) {
      end += 1
    }
    const after = end + 1
    if (after < bare.length && !isBlank(bare[after]!)) {
      continue
    }
    for (let back = index - 1; back >= 0 && isBlank(bare[back]!); back--) {
      removed[back] = true
    }
  }
}
