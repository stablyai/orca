// The save-divergence log's before (main's) and after (the save's) values of each changed field,
// bounded and stripped of content: ids (an editor tab's is its file path, as `paths` already
// shows), numbers and flags as they are, any other text only as its length, since titles, labels
// and records can hold what a user typed or an agent wrote.

/** Keys whose text is an id or a fixed name, read only inside the layout's own records; an array's items take its key. */
const ID_KEYS = new Set([
  'id',
  'entityId',
  'groupId',
  'leafId',
  'chatLeafId',
  'ptyId',
  'incarnationId',
  'tabOrder',
  'pageIds',
  'sessionProfileId',
  'type',
  'kind',
  'direction',
  'viewMode',
  'agentSessionAgent',
  'launchAgent',
  'color'
])
/**
 * Records and fields that embed other subsystems' data (an agent's resume record carries its prompt,
 * launch env and transcript path; editor views carry git snapshots): only their size is logged.
 */
const OPAQUE_RECORDS = new Set(['file', 'editor view'])
const OPAQUE_FIELDS = new Set(['sleeping', 'resume', 'value'])
const MAX_SHOWN_ID_LENGTH = 80
/** A daemon terminal id embeds its worktree id, which may be a long path. */
const MAX_SHOWN_PTY_ID_LENGTH = 256
const MAX_ITEMS = 8
const MAX_DEPTH = 6
/** Changed fields one report line carries values for. */
const MAX_CHANGES = 8
/** Values each side of one change may carry, counted per array, object and scalar. */
const SIDE_BUDGET = 32

/** One changed field of one record (`<kind> <id>`), as main holds it and as the save writes it. */
export type FieldChange = { record: string; field: string; before: unknown; after: unknown }

type Budget = { left: number }

function compact(
  value: unknown,
  key: string | undefined,
  budget: Budget,
  depth: number,
  opaque: boolean
): unknown {
  if (budget.left <= 0) {
    return '…'
  }
  budget.left--
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const limit = key === 'ptyId' ? MAX_SHOWN_PTY_ID_LENGTH : MAX_SHOWN_ID_LENGTH
    return !opaque && key && ID_KEYS.has(key) && value.length <= limit
      ? value
      : `<text ${value.length}>`
  }
  if (typeof value !== 'object') {
    return `<${typeof value}>`
  }
  if (Array.isArray(value)) {
    if (opaque || depth >= MAX_DEPTH) {
      return `<${value.length} items>`
    }
    const shown = value
      .slice(0, MAX_ITEMS)
      .map((item) => compact(item, key, budget, depth + 1, false))
    return value.length > MAX_ITEMS ? [...shown, `+${value.length - MAX_ITEMS} more`] : shown
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (opaque || depth >= MAX_DEPTH) {
    return `<${entries.length} keys>`
  }
  const shown = Object.fromEntries(
    entries
      .slice(0, MAX_ITEMS)
      .map(([name, item]) => [name, compact(item, name, budget, depth + 1, false)])
  )
  return entries.length > MAX_ITEMS
    ? { ...shown, '+': `${entries.length - MAX_ITEMS} more keys` }
    : shown
}

/** `changes` (with the kind of record each names) compacted for one report line. */
export function compactFieldChanges(
  changes: readonly (FieldChange & { kind: string })[]
): FieldChange[] {
  return changes.slice(0, MAX_CHANGES).map(({ kind, record, field, before, after }) => {
    const opaque = OPAQUE_RECORDS.has(kind) || OPAQUE_FIELDS.has(field)
    return {
      record,
      field,
      before: compact(before, field, { left: SIDE_BUDGET }, 0, opaque),
      after: compact(after, field, { left: SIDE_BUDGET }, 0, opaque)
    }
  })
}
