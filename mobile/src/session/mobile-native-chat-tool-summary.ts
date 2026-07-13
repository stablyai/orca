// Why: tool-call inputs are arbitrary JSON; the chat row only shows a one-line
// preview so a long file body or diff doesn't dominate the conversation. Kept
// pure so the truncation/serialization rules are unit-testable.

const MAX_PREVIEW_LENGTH = 80
const MAX_PREVIEW_STRING_INPUT = 160
const MAX_PREVIEW_COLLECTION_ITEMS = 8
const MAX_PREVIEW_DEPTH = 2
const MAX_TOOL_RUN_SUMMARY_PARTS = 3

/** One-line, length-capped preview of a tool-call input payload. Strings pass
 *  through; objects/arrays serialize to compact JSON; everything collapses
 *  whitespace and truncates with an ellipsis. Returns '' when there's nothing
 *  worth showing. */
export function summarizeToolInput(input: unknown): string {
  const raw = toRawPreview(input)
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_PREVIEW_LENGTH) {
    return collapsed
  }
  return `${collapsed.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
}

/** The worktree-relative file path a tool call targets, if any (Read/Edit/Write/
 *  NotebookEdit), so the chat can render the tool line as a tappable file link.
 *  Absolute paths are returned as-is; the opener resolves them against the
 *  worktree. Returns null when the call has no single file target. */
export function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const obj = input as Record<string, unknown>
  const path = obj.file_path ?? obj.filePath ?? obj.path ?? obj.notebook_path
  return typeof path === 'string' && path.length > 0 ? path : null
}

/** A very short hint for a tool call in a one-line run summary: the target file's
 *  basename when present, else a clipped preview of the input. */
export function briefToolArg(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const path = obj.file_path ?? obj.path ?? obj.notebook_path
    if (typeof path === 'string' && path.length > 0) {
      // Paths come raw from agent transcripts; Windows hosts emit backslashes.
      return path.split(/[\\/]/).pop() ?? path
    }
    const cmd = obj.command ?? obj.cmd ?? obj.query ?? obj.pattern
    if (typeof cmd === 'string') {
      return summarizeToolInput(cmd).slice(0, 28)
    }
  }
  return summarizeToolInput(input).slice(0, 28)
}

/** One-line summary of a run of tool calls: "Bash git status · Edit app.tsx · …".
 *  `blocks` are the run's blocks; only tool calls contribute names. */
export function summarizeToolRun(
  blocks: ReadonlyArray<{ type: string; name?: string; input?: unknown }>
): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== 'tool-call') {
      continue
    }
    const brief = briefToolArg(block.input)
    parts.push(brief ? `${block.name ?? 'tool'} ${brief}` : (block.name ?? 'tool'))
    if (parts.length >= MAX_TOOL_RUN_SUMMARY_PARTS) {
      break
    }
  }
  return parts.join('  ·  ')
}

function toRawPreview(input: unknown): string {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input === 'string') {
    return input
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input)
  }
  try {
    return JSON.stringify(boundedPreviewValue(input, 0, new WeakSet<object>())) ?? ''
  } catch {
    return ''
  }
}

function boundedPreviewValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_PREVIEW_STRING_INPUT
      ? `${value.slice(0, MAX_PREVIEW_STRING_INPUT)}…`
      : value
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[circular]'
  }
  if (depth >= MAX_PREVIEW_DEPTH) {
    return '[…]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (let index = 0; index < value.length && index < MAX_PREVIEW_COLLECTION_ITEMS; index++) {
      result.push(boundedPreviewValue(value[index], depth + 1, seen))
    }
    if (value.length > MAX_PREVIEW_COLLECTION_ITEMS) {
      result.push('…')
    }
    return result
  }
  const result: Record<string, unknown> = {}
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue
    }
    if (count >= MAX_PREVIEW_COLLECTION_ITEMS) {
      result['…'] = '…'
      break
    }
    result[key] = boundedPreviewValue((value as Record<string, unknown>)[key], depth + 1, seen)
    count++
  }
  return result
}
