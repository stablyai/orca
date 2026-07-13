// Why: agent edits show up as tool calls (Edit/Write with old/new strings) and
// tool results that contain unified-diff text. The chat renders these as inline
// coloured diffs like the terminal, so detection/parsing is pure and testable.

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  text: string
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'str_replace', 'apply_patch'])
const MAX_DIFF_CHARS = 32_000
const DEFAULT_MAX_DIFF_LINES = 120
const DIFF_TRUNCATED_LINE: DiffLine = { kind: 'meta', text: '… diff truncated …' }

function toLines(value: unknown, maxLines: number): { lines: string[]; truncated: boolean } {
  if (typeof value !== 'string') {
    return { lines: [], truncated: false }
  }
  const clipped = value.slice(0, MAX_DIFF_CHARS)
  const lines = clipped.split('\n', maxLines + 1)
  const truncated = value.length > MAX_DIFF_CHARS || lines.length > maxLines
  const bounded = lines.slice(0, maxLines)
  if (!truncated && bounded.at(-1) === '') {
    bounded.pop()
  }
  return { lines: bounded, truncated }
}

/** Build diff lines from an Edit-style tool call input (old_string/new_string),
 *  or null when the input isn't an editing payload. Old lines render as deletes,
 *  new lines as adds — a simple, readable before/after rather than a full LCS. */
export function diffFromToolCall(
  name: string,
  input: unknown,
  maxLines = DEFAULT_MAX_DIFF_LINES
): DiffLine[] | null {
  if (!EDIT_TOOL_NAMES.has(name) || typeof input !== 'object' || input === null) {
    return null
  }
  const obj = input as Record<string, unknown>
  const oldText = obj.old_string ?? obj.oldString ?? obj.old
  const newText = obj.new_string ?? obj.newString ?? obj.new ?? obj.content ?? obj.file_text
  const oldLines = toLines(oldText, maxLines)
  const newLines = toLines(newText, maxLines)
  const dels = oldLines.lines.map((text): DiffLine => ({ kind: 'del', text }))
  const adds = newLines.lines.map((text): DiffLine => ({ kind: 'add', text }))
  if (dels.length === 0 && adds.length === 0) {
    return null
  }
  const lines: DiffLine[] = []
  if (typeof obj.file_path === 'string' || typeof obj.path === 'string') {
    lines.push({ kind: 'meta', text: String(obj.file_path ?? obj.path) })
  }
  const combined = [...lines, ...dels, ...adds]
  const truncated = oldLines.truncated || newLines.truncated || combined.length > maxLines
  return truncated ? [...combined.slice(0, maxLines - 1), DIFF_TRUNCATED_LINE] : combined
}

/** Parse unified-diff-looking text into coloured lines, or null when the text
 *  doesn't read as a diff (no +/- lines). */
export function diffFromText(text: string, maxLines = DEFAULT_MAX_DIFF_LINES): DiffLine[] | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null
  }
  const bounded = toLines(text, maxLines)
  let added = 0
  let removed = 0
  const lines: DiffLine[] = bounded.lines.map((line): DiffLine => {
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta', text: line }
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
      return { kind: 'add', text: line.slice(1) }
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
      return { kind: 'del', text: line.slice(1) }
    }
    return { kind: 'context', text: line }
  })
  // Require a meaningful amount of diff signal so ordinary prose isn't mistaken
  // for a diff (a stray leading '-' bullet shouldn't trigger diff rendering).
  if (added + removed < 2) {
    return null
  }
  return bounded.truncated ? [...lines.slice(0, maxLines - 1), DIFF_TRUNCATED_LINE] : lines
}
