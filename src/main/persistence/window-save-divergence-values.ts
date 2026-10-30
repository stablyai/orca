// Bound divergence logs to IDs, numbers and flags; log other text only by length to exclude user/agent content.

/** ID/fixed-name fields inside layout records; array items inherit their key. */
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
// Embedded agent/editor data may include prompts, environment or snapshots; report only size.
const OPAQUE_RECORDS = new Set(['file', 'editor view'])
const OPAQUE_FIELDS = new Set(['sleeping', 'resume', 'value'])
const MAX_SHOWN_ID_LENGTH = 80
// Daemon IDs embed potentially long worktree paths.
const MAX_SHOWN_PTY_ID_LENGTH = 256
const MAX_ITEMS = 8
const MAX_DEPTH = 6
const MAX_CHANGES = 8
/** Per-side budget counts arrays, objects and scalars. */
const SIDE_BUDGET = 32

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
