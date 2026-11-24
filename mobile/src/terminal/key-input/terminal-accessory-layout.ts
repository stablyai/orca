import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../../storage/mirrored-storage-keys'

import './terminal-accessory-keys'
import type { TerminalAccessoryKey } from './terminal-accessory-keys'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS as TERMINAL_ACCESSORY_KEYS } from './terminal-key-definitions'
import {
  MIN_TERMINAL_ACCESSORY_ROWS,
  buildTerminalAccessoryPreference,
  clampTerminalAccessoryRowCount,
  dedupeKnownIds,
  foldTerminalAccessoryRows,
  normalizePersistedAccessoryLayout,
  parseTerminalAccessoryRowReorderIds,
  type TerminalAccessoryLayout,
  type TerminalAccessoryLayoutPreference
} from './terminal-accessory-rows'

export {
  MAX_TERMINAL_ACCESSORY_ROWS,
  MIN_TERMINAL_ACCESSORY_ROWS,
  ROW_DIVIDER_ID_PREFIX,
  type TerminalAccessoryLayout,
  type TerminalAccessoryLayoutPreference
} from './terminal-accessory-rows'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'

function builtInIds(): string[] {
  return TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
}

function defaultPreference(
  ids = builtInIds(),
  directionPadAvailable = false
): TerminalAccessoryLayoutPreference {
  return {
    version: 3,
    rowCount: MIN_TERMINAL_ACCESSORY_ROWS,
    rows: [[...ids]],
    orderedBuiltInIds: [...ids],
    visibleBuiltInIds: directionPadAvailable
      ? ids.filter((id) => !id.startsWith('arrow'))
      : [...ids],
    directionPadEnabled: true,
    smartRail: false
  }
}

function stripVersion(pref: TerminalAccessoryLayoutPreference): TerminalAccessoryLayout {
  const { version: _version, ...layout } = pref
  return layout
}

export function getDefaultTerminalAccessoryBuiltInIds(): string[] {
  return builtInIds()
}

/** Returns the default built-in terminal accessory layout (single row). */
export function getDefaultTerminalAccessoryLayout(
  directionPadAvailable = false
): TerminalAccessoryLayout {
  return stripVersion(defaultPreference(builtInIds(), directionPadAvailable))
}

/** Normalizes v1/v2/v3 persisted shortcut bar preferences into version 3 multi-row format. */
export function normalizeTerminalAccessoryLayoutPreference(
  value: unknown,
  currentBuiltInIds = builtInIds(),
  directionPadAvailable = false
): TerminalAccessoryLayoutPreference {
  return normalizePersistedAccessoryLayout(
    value,
    currentBuiltInIds,
    defaultPreference(currentBuiltInIds, directionPadAvailable)
  )
}

/** Converts an arbitrary layout object into a normalized version-3 preference payload. */
export function createTerminalAccessoryLayoutPreference(
  layout: TerminalAccessoryLayout,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  const rowCount = clampTerminalAccessoryRowCount(
    layout.rowCount ?? layout.rows?.length ?? MIN_TERMINAL_ACCESSORY_ROWS
  )
  const candidateRows =
    layout.rows && layout.rows.length > 0 ? layout.rows : [layout.orderedBuiltInIds]
  return buildTerminalAccessoryPreference(
    candidateRows,
    rowCount,
    layout.visibleBuiltInIds,
    currentBuiltInIds,
    false,
    layout.directionPadEnabled !== false,
    layout.smartRail === true,
    layout.preservedRows
  )
}

/** Toggles visibility of a built-in shortcut key while preserving row assignments. */
export function setTerminalAccessoryBuiltInVisible(
  layout: TerminalAccessoryLayout,
  id: string,
  visible: boolean,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  if (!currentBuiltInIds.includes(id)) {
    return stripVersion(preference)
  }
  const visibleSet = new Set(preference.visibleBuiltInIds)
  if (visible) {
    visibleSet.add(id)
  } else {
    visibleSet.delete(id)
  }
  return {
    ...stripVersion(preference),
    visibleBuiltInIds: preference.orderedBuiltInIds.filter((builtInId) => visibleSet.has(builtInId))
  }
}

/** Replaces built-in ordering as a single row for callers that do not partition rows. */
export function reorderTerminalAccessoryBuiltInIds(
  layout: TerminalAccessoryLayout,
  orderedBuiltInIds: string[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  return stripVersion(
    buildTerminalAccessoryPreference(
      [orderedBuiltInIds],
      1,
      layout.visibleBuiltInIds,
      currentBuiltInIds,
      false,
      layout.directionPadEnabled !== false,
      layout.smartRail === true
    )
  )
}

/** Updates rowCount (clamped 1–6), preserving the unshrunk row partition so re-expanding restores it. */
export function setTerminalAccessoryRowCount(
  layout: TerminalAccessoryLayout,
  nextRowCount: number,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const current = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  const rowCount = clampTerminalAccessoryRowCount(nextRowCount)
  const sourceRows =
    current.preservedRows && current.preservedRows.length > current.rowCount
      ? current.preservedRows
      : current.rows
  const rows = foldTerminalAccessoryRows(sourceRows, rowCount)
  const nextPreservedRows = sourceRows.length > rowCount ? sourceRows : undefined
  return stripVersion(
    buildTerminalAccessoryPreference(
      rows,
      rowCount,
      current.visibleBuiltInIds,
      currentBuiltInIds,
      false,
      current.directionPadEnabled !== false,
      current.smartRail === true,
      nextPreservedRows
    )
  )
}

/** Reorders built-in keys across row-divider markers and preserves visible selections. */
export function reorderTerminalAccessoryBuiltInRows(
  layout: TerminalAccessoryLayout,
  orderedIdsWithDividers: string[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const current = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  const rows = parseTerminalAccessoryRowReorderIds(orderedIdsWithDividers, current.rowCount)
  return stripVersion(
    buildTerminalAccessoryPreference(
      rows,
      current.rowCount,
      current.visibleBuiltInIds,
      currentBuiltInIds,
      false,
      current.directionPadEnabled !== false,
      current.smartRail === true
    )
  )
}

/** Returns partitioned built-in key IDs across the configured 1–6 rows. */
export function getTerminalAccessoryBuiltInRows(
  layout: TerminalAccessoryLayout,
  currentBuiltInIds = builtInIds()
): string[][] {
  return createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds).rows!
}

/** Maps a flat list of visible built-in IDs into key definitions. */
export function getVisibleTerminalAccessoryKeys(
  visibleBuiltInIds: string[],
  includeDirectionKeys = false
): TerminalAccessoryKey[] {
  const ids = includeDirectionKeys
    ? [...visibleBuiltInIds, ...builtInIds().filter((id) => id.startsWith('arrow'))]
    : visibleBuiltInIds
  const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
  return dedupeKnownIds(ids, new Set(byId.keys())).flatMap((id) => {
    const key = byId.get(id)
    return key ? [key] : []
  })
}

/** Maps each configured shortcut row to its visible built-in key definitions. */
export function getVisibleTerminalAccessoryBuiltInRows(
  layout: TerminalAccessoryLayout,
  includeDirectionKeys = false,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryKey[][] {
  const normalized = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  const visibleSet = new Set(normalized.visibleBuiltInIds)
  if (includeDirectionKeys) {
    for (const id of currentBuiltInIds) {
      if (id.startsWith('arrow')) {
        visibleSet.add(id)
      }
    }
  }
  const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
  return normalized.rows.map((row) =>
    row.flatMap((id) => {
      if (!visibleSet.has(id)) {
        return []
      }
      const key = byId.get(id)
      return key ? [key] : []
    })
  )
}

// Throws only when the store can't be read; a malformed value reads as the defaults.
async function readTerminalAccessoryLayout(
  directionPadAvailable: boolean
): Promise<TerminalAccessoryLayoutPreference> {
  const raw = await AsyncStorage.getItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY)
  let stored: unknown = null
  try {
    stored = raw ? JSON.parse(raw) : null
  } catch {}
  return normalizeTerminalAccessoryLayoutPreference(stored, builtInIds(), directionPadAvailable)
}

export function loadTerminalAccessoryLayout(
  directionPadAvailable = false
): Promise<TerminalAccessoryLayoutPreference> {
  return readTerminalAccessoryLayout(directionPadAvailable).catch(() =>
    defaultPreference(builtInIds(), directionPadAvailable)
  )
}

export async function saveTerminalAccessoryLayout(layout: TerminalAccessoryLayout): Promise<void> {
  const preference = createTerminalAccessoryLayoutPreference(layout)
  const value = JSON.stringify(preference)
  await persistMirrored(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, value)
}

// Serialize read-modify-write so quick toggles land in order.
let layoutWriteTurn: Promise<unknown> = Promise.resolve()

/** Turns the Smart rail on or off, keeping the rest of the stored layout. */
export function saveTerminalSmartRail(
  enabled: boolean,
  directionPadAvailable = false
): Promise<void> {
  const run = layoutWriteTurn.then(async () => {
    // A failed read must not save defaults over the user's layout.
    const layout = await readTerminalAccessoryLayout(directionPadAvailable)
    await saveTerminalAccessoryLayout({ ...layout, smartRail: enabled })
  })
  layoutWriteTurn = run.catch(() => {})
  return run
}
