/**
 * What the real round trip may legitimately change, so the comparison catches everything else:
 * schema defaults the host's load fills in, ids it derives, and representation changes the move
 * makes on purpose. Each known gap is a real loss, named here so a fix has to remove it.
 */
import { isRecord } from '../../moving-wsl-projects/wsl-move-canonical-form'

/** Session fields the real pipeline does not carry yet, with why; each still differs today. */
export const WSL_MOVE_ROUND_TRIP_KNOWN_GAPS: Readonly<Record<string, string>> = {
  activeWorktreeIdsOnShutdown: 'Never seeded: focus belongs to whoever looks at the host.',
  terminalSurfaceTombstonesByPaneKey: 'Fences of local PTY incarnations; the host starts its own.'
}

// Row keys the host's load fills in; dropped only where the source row left the key out.
const FILLED_IN: Readonly<Record<string, readonly string[]>> = {
  repos: ['gitUsername', 'hookSettings', 'kind'],
  projects: ['kind'],
  // Re-derived on the host from the project the setup resolves to.
  worktreeMeta: ['projectId']
}
// Moved disabled; the ledgered `host-automations` step turns them back on (checked separately).
const BOTH_SIDES: Readonly<Record<string, readonly string[]>> = { automations: ['enabled'] }
const DEFAULTED_SESSION: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  browserTabsByWorktree: { sessionPartition: null, sessionProfileId: null },
  sleepingAgentSessionsByPaneKey: { connectionId: null }
}

type Rows = Map<string, Record<string, unknown>>

/** A field's rows by id (arrays) or by key (records). */
function rowsOf(value: unknown): Rows {
  const rows: Rows = new Map()
  const entries = Array.isArray(value)
    ? value.map((row): [unknown, unknown] => [isRecord(row) ? row.id : undefined, row])
    : Object.entries(isRecord(value) ? value : {})
  for (const [id, row] of entries) {
    if (typeof id === 'string' && isRecord(row)) {
      rows.set(id, row)
    }
  }
  return rows
}

/** Top-level row keys in `keys` dropped where `drop` says so; nested values are never touched. */
function withoutRowKeys(
  value: unknown,
  keys: readonly string[],
  drop: (id: string, key: string) => boolean
): unknown {
  const next: unknown = structuredClone(value ?? null)
  for (const [id, row] of rowsOf(next)) {
    for (const key of keys) {
      if (drop(id, key)) {
        delete row[key]
      }
    }
  }
  return next
}

function withoutDefaultValues(
  value: unknown,
  defaults: Readonly<Record<string, unknown>>
): unknown {
  return JSON.parse(JSON.stringify(value ?? null), (key, entry: unknown) =>
    Object.hasOwn(defaults, key) && entry === defaults[key] ? undefined : entry
  )
}

/** Empty per-repo lists are the same as none. */
function withoutEmptyLists(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => !(Array.isArray(entry) && entry.length === 0))
  )
}

/**
 * Local-only scrollback travels as a host scrollback snapshot. Returns the destination session
 * with exactly those snapshot refs removed, or null when a parked leaf did not become one.
 */
export function withoutParkedScrollbackRefs(
  sourceSession: unknown,
  destinationSession: unknown
): Record<string, unknown> | null {
  const parked = isRecord(sourceSession) ? sourceSession.localOnlyScrollbackByTabId : undefined
  const next = structuredClone(isRecord(destinationSession) ? destinationSession : {})
  const layouts = next.terminalLayoutsByTabId
  for (const [tabId, leaves] of Object.entries(isRecord(parked) ? parked : {})) {
    const layout = isRecord(layouts) ? layouts[tabId] : undefined
    const refs = isRecord(layout) ? layout.scrollbackRefsByLeafId : undefined
    if (!isRecord(layout) || !isRecord(refs) || !isRecord(leaves)) {
      return null
    }
    for (const leafId of Object.keys(leaves)) {
      if (typeof refs[leafId] !== 'string') {
        return null
      }
      delete refs[leafId]
    }
    if (Object.keys(refs).length === 0) {
      delete layout.scrollbackRefsByLeafId
    }
  }
  return next
}

/**
 * One projection with every allowed difference taken out. `source` is the source projection when
 * normalizing the destination: a filled-in key goes only where that source row lacked it.
 */
export function normalizeWslMoveRoundTripProjection(
  projection: unknown,
  source?: unknown
): unknown {
  if (!isRecord(projection)) {
    return projection
  }
  const next: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(projection)) {
    if (field === 'session') {
      continue
    }
    const sourceRows = rowsOf(isRecord(source) ? source[field] : undefined)
    const filledIn = FILLED_IN[field]
    const bothSides = BOTH_SIDES[field]
    next[field] =
      field === 'sparsePresetsByRepo'
        ? withoutEmptyLists(value)
        : bothSides
          ? withoutRowKeys(value, bothSides, () => true)
          : filledIn && source !== undefined
            ? withoutRowKeys(
                value,
                filledIn,
                (id, key) => !Object.hasOwn(sourceRows.get(id) ?? {}, key)
              )
            : value
  }
  const session = isRecord(projection.session) ? projection.session : {}
  const nextSession: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(session)) {
    if (
      Object.hasOwn(WSL_MOVE_ROUND_TRIP_KNOWN_GAPS, field) ||
      field === 'localOnlyScrollbackByTabId'
    ) {
      continue
    }
    // An empty record is the same as none.
    if (isRecord(value) && Object.keys(value).length === 0) {
      continue
    }
    const defaults = DEFAULTED_SESSION[field]
    nextSession[field] = defaults ? withoutDefaultValues(value, defaults) : value
  }
  next.session = nextSession
  return next
}
