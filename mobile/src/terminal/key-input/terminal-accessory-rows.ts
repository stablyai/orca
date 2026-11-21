export const MIN_TERMINAL_ACCESSORY_ROWS = 1
export const MAX_TERMINAL_ACCESSORY_ROWS = 4
export const ROW_DIVIDER_ID_PREFIX = '__row_divider_'

export type TerminalAccessoryLayout = {
  rowCount?: number
  rows?: string[][]
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
  directionPadEnabled?: boolean
  /** Agent keys at the front of the phone's key row; off unless the user turns it on. */
  smartRail?: boolean
}

export type TerminalAccessoryLayoutPreference = TerminalAccessoryLayout & {
  version: 3
  rowCount: number
  rows: string[][]
}

/** Clamps a candidate accessory row count to the supported 1–4 range. */
export function clampTerminalAccessoryRowCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MIN_TERMINAL_ACCESSORY_ROWS
  }
  return Math.min(
    MAX_TERMINAL_ACCESSORY_ROWS,
    Math.max(MIN_TERMINAL_ACCESSORY_ROWS, Math.trunc(value))
  )
}

/** Validates an array of arbitrary-depth string rows from persisted preferences. */
export function readAccessoryRowMatrix(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const rows: string[][] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || !entry.every((item): item is string => typeof item === 'string')) {
      return null
    }
    rows.push(entry)
  }
  return rows
}

export function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.every((item): item is string => typeof item === 'string') ? value : null
}

export function dedupeKnownIds(ids: readonly string[], builtInSet: Set<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!builtInSet.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Normalizes built-in accessory rows, placing newly added built-ins beside canonical neighbors. */
export function normalizeBuiltInAccessoryRows(
  candidateRows: readonly (readonly string[])[],
  rowCount: number,
  currentBuiltInIds: readonly string[]
): { rows: string[][]; orderedBuiltInIds: string[]; inserted: string[] } {
  const clampedCount = clampTerminalAccessoryRowCount(rowCount)
  const builtInSet = new Set(currentBuiltInIds)
  const rows: string[][] = Array.from({ length: clampedCount }, () => [])
  const seen = new Set<string>()

  for (let rowIndex = 0; rowIndex < candidateRows.length; rowIndex++) {
    const targetRow = rows[Math.min(rowIndex, clampedCount - 1)]!
    for (const id of candidateRows[rowIndex]!) {
      if (builtInSet.has(id) && !seen.has(id)) {
        seen.add(id)
        targetRow.push(id)
      }
    }
  }

  const inserted: string[] = []
  for (let i = 0; i < currentBuiltInIds.length; i++) {
    const id = currentBuiltInIds[i]!
    if (seen.has(id)) {
      continue
    }
    let targetRowIdx = 0
    let insertAt = 0
    for (let j = i - 1; j >= 0; j--) {
      const prevId = currentBuiltInIds[j]!
      const foundRow = rows.findIndex((row) => row.includes(prevId))
      if (foundRow !== -1) {
        targetRowIdx = foundRow
        insertAt = rows[foundRow]!.indexOf(prevId) + 1
        break
      }
    }
    rows[targetRowIdx]!.splice(insertAt, 0, id)
    seen.add(id)
    inserted.push(id)
  }

  return { rows, orderedBuiltInIds: rows.flat(), inserted }
}

/** Splits an interleaved DragReorderList id sequence at row-divider markers into row arrays. */
export function parseTerminalAccessoryRowReorderIds(
  orderedIds: readonly string[],
  rowCount: number
): string[][] {
  const clampedCount = clampTerminalAccessoryRowCount(rowCount)
  const rows: string[][] = Array.from({ length: clampedCount }, () => [])
  let rowIndex = 0
  for (const id of orderedIds) {
    if (id.startsWith(ROW_DIVIDER_ID_PREFIX)) {
      rowIndex = Math.min(clampedCount - 1, rowIndex + 1)
    } else {
      rows[rowIndex]!.push(id)
    }
  }
  return rows
}

/** Builds a normalized version-3 accessory preference payload from candidate rows and flags. */
export function buildTerminalAccessoryPreference(
  candidateRows: readonly (readonly string[])[],
  rowCount: number,
  visibleInput: readonly string[],
  currentBuiltInIds: readonly string[],
  includeInserted: boolean,
  directionPadEnabled: boolean,
  smartRail: boolean
): TerminalAccessoryLayoutPreference {
  const clampedCount = clampTerminalAccessoryRowCount(rowCount)
  const { rows, orderedBuiltInIds, inserted } = normalizeBuiltInAccessoryRows(
    candidateRows,
    clampedCount,
    currentBuiltInIds
  )
  const visibleSet = new Set(dedupeKnownIds(visibleInput, new Set(currentBuiltInIds)))
  if (includeInserted) {
    for (const id of inserted) {
      visibleSet.add(id)
    }
  }
  return {
    version: 3,
    rowCount: clampedCount,
    rows,
    directionPadEnabled,
    smartRail,
    orderedBuiltInIds,
    visibleBuiltInIds: orderedBuiltInIds.filter((id) => visibleSet.has(id))
  }
}

/** Normalizes v1/v2/v3 persisted shortcut bar preferences into version 3 multi-row format. */
export function normalizePersistedAccessoryLayout(
  value: unknown,
  currentBuiltInIds: readonly string[],
  fallback: TerminalAccessoryLayoutPreference
): TerminalAccessoryLayoutPreference {
  if (!value || typeof value !== 'object') {
    return fallback
  }
  const candidate = {
    version: 'version' in value ? value.version : undefined,
    orderedBuiltInIds: 'orderedBuiltInIds' in value ? value.orderedBuiltInIds : undefined,
    visibleBuiltInIds: 'visibleBuiltInIds' in value ? value.visibleBuiltInIds : undefined,
    knownBuiltInIds: 'knownBuiltInIds' in value ? value.knownBuiltInIds : undefined,
    directionPadEnabled: 'directionPadEnabled' in value ? value.directionPadEnabled : undefined,
    smartRail: 'smartRail' in value ? value.smartRail : undefined,
    rows: 'rows' in value ? value.rows : undefined,
    rowCount: 'rowCount' in value ? value.rowCount : undefined
  }
  const builtInSet = new Set(currentBuiltInIds)
  const visibleInput = stringArray(candidate.visibleBuiltInIds)
  if (!visibleInput) {
    return fallback
  }
  const directionPadEnabled = candidate.directionPadEnabled !== false
  const smartRail = candidate.smartRail === true

  if (candidate.version === 3 || candidate.version === 2) {
    const orderedInput = stringArray(candidate.orderedBuiltInIds)
    const rows =
      candidate.version === 3
        ? readAccessoryRowMatrix(candidate.rows)
        : orderedInput
          ? [orderedInput]
          : null
    if (!rows) {
      return fallback
    }
    const rowCount =
      candidate.version === 3
        ? clampTerminalAccessoryRowCount(candidate.rowCount ?? rows.length)
        : 1
    return buildTerminalAccessoryPreference(
      rows,
      rowCount,
      visibleInput,
      currentBuiltInIds,
      true,
      directionPadEnabled,
      smartRail
    )
  }

  if (candidate.version === 1) {
    const knownInput = stringArray(candidate.knownBuiltInIds)
    if (!knownInput) {
      return fallback
    }
    const knownInputSet = new Set(knownInput.filter((id) => builtInSet.has(id)))
    const visible = [...visibleInput, ...currentBuiltInIds.filter((id) => !knownInputSet.has(id))]
    // Version-one layouts had no custom order; migrate them to canonical order.
    return buildTerminalAccessoryPreference(
      [currentBuiltInIds],
      1,
      visible,
      currentBuiltInIds,
      false,
      directionPadEnabled,
      smartRail
    )
  }

  return fallback
}
