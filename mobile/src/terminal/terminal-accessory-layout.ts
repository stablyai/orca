import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import { TERMINAL_ACCESSORY_KEYS, type TerminalAccessoryKey } from './terminal-accessory-keys'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'
export const MIN_TERMINAL_ACCESSORY_ROWS = 1
export const MAX_TERMINAL_ACCESSORY_ROWS = 4
export const CUSTOM_ACCESSORY_KEY_ID_PREFIX = 'custom-'
export const ROW_DIVIDER_ID_PREFIX = '__row_divider_'

export type TerminalAccessoryLayout = {
  rowCount?: number
  rows?: string[][]
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
}

export type NormalizedTerminalAccessoryLayout = Required<TerminalAccessoryLayout>

export type TerminalAccessoryLayoutPreference = NormalizedTerminalAccessoryLayout & {
  version: 3
}

export type TerminalAccessoryBarItem<TCustom extends { id: string } = { id: string }> =
  | { kind: 'built-in'; key: TerminalAccessoryKey }
  | { kind: 'custom'; key: TCustom }

const builtInIds = (): string[] => TERMINAL_ACCESSORY_KEYS.map((key) => key.id)

export const isCustomAccessoryKeyId = (id: string): boolean =>
  id.startsWith(CUSTOM_ACCESSORY_KEY_ID_PREFIX) && id.length > CUSTOM_ACCESSORY_KEY_ID_PREFIX.length

const clampRows = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(MAX_TERMINAL_ACCESSORY_ROWS, Math.max(MIN_TERMINAL_ACCESSORY_ROWS, Math.trunc(v)))
    : MIN_TERMINAL_ACCESSORY_ROWS

const stripVersion = ({
  version: _version,
  ...layout
}: TerminalAccessoryLayoutPreference): NormalizedTerminalAccessoryLayout => layout

const stringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null

const rowsArray = (v: unknown): string[][] | null => {
  const rows = Array.isArray(v) && v.length > 0 ? v.map(stringArray) : null
  return rows && rows.every((r): r is string[] => r !== null) ? rows : null
}

const dedupeKnownIds = (ids: string[], allowed: Set<string>): string[] =>
  Array.from(new Set(ids.filter((id) => allowed.has(id))))

// Why: built-ins added after the user saved a custom order should land next
// to their canonical neighbors in the same row, not dangle at the end.
function buildPreference(
  candidateRows: string[][],
  rowCount: number,
  visibleIds: string[],
  currentBuiltInIds: string[],
  includeInserted = false
): TerminalAccessoryLayoutPreference {
  const builtInSet = new Set(currentBuiltInIds)
  const rows: string[][] = Array.from({ length: rowCount }, () => [])
  const seen = new Set<string>()

  candidateRows.forEach((row, r) => {
    for (const id of row) {
      if ((builtInSet.has(id) || isCustomAccessoryKeyId(id)) && !seen.has(id)) {
        seen.add(id)
        rows[Math.min(r, rowCount - 1)]!.push(id)
      }
    }
  })

  const inserted: string[] = []
  currentBuiltInIds.forEach((id, i) => {
    if (seen.has(id)) {
      return
    }
    let rowIdx = 0
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const pIdx = rows.findIndex((row) => row.includes(currentBuiltInIds[j]!))
      if (pIdx !== -1) {
        rowIdx = pIdx
        at = rows[pIdx]!.indexOf(currentBuiltInIds[j]!) + 1
        break
      }
    }
    rows[rowIdx]!.splice(at, 0, id)
    seen.add(id)
    inserted.push(id)
  })

  const orderedBuiltInIds = rows.flat().filter((id) => builtInSet.has(id))
  const visibleSet = new Set([
    ...dedupeKnownIds(visibleIds, builtInSet),
    ...(includeInserted ? inserted : [])
  ])
  return {
    version: 3,
    rowCount,
    rows,
    orderedBuiltInIds,
    visibleBuiltInIds: orderedBuiltInIds.filter((id) => visibleSet.has(id))
  }
}

const defaultPreference = (ids = builtInIds()): TerminalAccessoryLayoutPreference =>
  buildPreference([ids], MIN_TERMINAL_ACCESSORY_ROWS, ids, ids)

export const getDefaultTerminalAccessoryBuiltInIds = (): string[] => builtInIds()

export const getDefaultTerminalAccessoryLayout = (): NormalizedTerminalAccessoryLayout =>
  stripVersion(defaultPreference())

export function normalizeTerminalAccessoryLayoutPreference(
  value: unknown,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  const fallback = defaultPreference(currentBuiltInIds)
  if (!value || typeof value !== 'object') {
    return fallback
  }
  const candidate = value as Record<string, unknown>
  const visibleInput = stringArray(candidate.visibleBuiltInIds)
  if (!visibleInput) {
    return fallback
  }

  if (candidate.version === 3 || candidate.version === 2) {
    const ordered = stringArray(candidate.orderedBuiltInIds)
    const rows = candidate.version === 3 ? rowsArray(candidate.rows) : ordered ? [ordered] : null
    const rowCount =
      candidate.version === 3 && rows ? clampRows(candidate.rowCount ?? rows.length) : 1
    return rows ? buildPreference(rows, rowCount, visibleInput, currentBuiltInIds, true) : fallback
  }

  if (candidate.version === 1) {
    const knownInput = stringArray(candidate.knownBuiltInIds)
    if (!knownInput) {
      return fallback
    }
    const knownSet = new Set(knownInput)
    const visible = [...visibleInput, ...currentBuiltInIds.filter((id) => !knownSet.has(id))]
    // Why: v1 layouts never had a custom order, so migrate to canonical order.
    return buildPreference([currentBuiltInIds], 1, visible, currentBuiltInIds)
  }

  return fallback
}

export function createTerminalAccessoryLayoutPreference(
  layout: TerminalAccessoryLayout,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  const rowCount = clampRows(layout.rowCount ?? layout.rows?.length ?? MIN_TERMINAL_ACCESSORY_ROWS)
  const rows = layout.rows && layout.rows.length > 0 ? layout.rows : [layout.orderedBuiltInIds]
  return buildPreference(rows, rowCount, layout.visibleBuiltInIds, currentBuiltInIds)
}

export function setTerminalAccessoryBuiltInVisible(
  layout: TerminalAccessoryLayout,
  id: string,
  visible: boolean,
  currentBuiltInIds = builtInIds()
): NormalizedTerminalAccessoryLayout {
  const pref = stripVersion(createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds))
  if (!currentBuiltInIds.includes(id)) {
    return pref
  }
  const visibleSet = new Set(pref.visibleBuiltInIds)
  if (visible) {
    visibleSet.add(id)
  } else {
    visibleSet.delete(id)
  }
  return { ...pref, visibleBuiltInIds: pref.orderedBuiltInIds.filter((k) => visibleSet.has(k)) }
}

export function reorderTerminalAccessoryBuiltInIds(
  layout: TerminalAccessoryLayout,
  orderedBuiltInIds: string[],
  currentBuiltInIds = builtInIds()
): NormalizedTerminalAccessoryLayout {
  return stripVersion(
    buildPreference([orderedBuiltInIds], 1, layout.visibleBuiltInIds, currentBuiltInIds)
  )
}

export function setTerminalAccessoryRowCount(
  layout: TerminalAccessoryLayout,
  nextRowCount: number,
  currentBuiltInIds = builtInIds()
): NormalizedTerminalAccessoryLayout {
  const current = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  const rowCount = clampRows(nextRowCount)
  const rows = Array.from({ length: rowCount }, (_, i) =>
    i === rowCount - 1 && rowCount < current.rowCount
      ? current.rows.slice(i).flat()
      : [...(current.rows[i] ?? [])]
  )
  return stripVersion(buildPreference(rows, rowCount, current.visibleBuiltInIds, currentBuiltInIds))
}

export function reconcileTerminalAccessoryLayoutCustomKeys(
  layout: TerminalAccessoryLayout,
  customKeyIds: string[],
  currentBuiltInIds = builtInIds()
): NormalizedTerminalAccessoryLayout {
  const current = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  const validCustomIds = customKeyIds.filter(isCustomAccessoryKeyId)
  const validCustomSet = new Set(validCustomIds)
  const rows = current.rows.map((row) =>
    row.filter((id) => !isCustomAccessoryKeyId(id) || validCustomSet.has(id))
  )
  const presentCustomSet = new Set(rows.flat().filter(isCustomAccessoryKeyId))
  for (const customId of validCustomIds) {
    if (!presentCustomSet.has(customId)) {
      presentCustomSet.add(customId)
      rows[rows.length - 1]!.push(customId)
    }
  }
  return stripVersion(
    buildPreference(rows, current.rowCount, current.visibleBuiltInIds, currentBuiltInIds)
  )
}

export function updateTerminalAccessoryRows(
  layout: TerminalAccessoryLayout,
  rows: string[][],
  currentBuiltInIds = builtInIds()
): NormalizedTerminalAccessoryLayout {
  const rowCount = clampRows(rows.length > 0 ? rows.length : layout.rowCount)
  return stripVersion(buildPreference(rows, rowCount, layout.visibleBuiltInIds, currentBuiltInIds))
}

export function parseTerminalAccessoryReorderIds(
  orderedIds: string[],
  rowCount: number
): string[][] {
  const clampedCount = clampRows(rowCount)
  const rows: string[][] = Array.from({ length: clampedCount }, () => [])
  let idx = 0
  for (const id of orderedIds) {
    if (id.startsWith(ROW_DIVIDER_ID_PREFIX)) {
      idx = Math.min(clampedCount - 1, idx + 1)
    } else {
      rows[idx]!.push(id)
    }
  }
  return rows
}

export function getVisibleTerminalAccessoryKeys(
  visibleBuiltInIds: string[]
): TerminalAccessoryKey[] {
  const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
  return dedupeKnownIds(visibleBuiltInIds, new Set(byId.keys())).flatMap((id) => {
    const key = byId.get(id)
    return key ? [key] : []
  })
}

export function getVisibleTerminalAccessoryRows<TCustom extends { id: string }>(
  layout: TerminalAccessoryLayout,
  customKeys: TCustom[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryBarItem<TCustom>[][] {
  const reconciled = reconcileTerminalAccessoryLayoutCustomKeys(
    layout,
    customKeys.map((key) => key.id),
    currentBuiltInIds
  )
  const builtInById = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
  const customById = new Map(customKeys.map((key) => [key.id, key]))
  const visibleBuiltInSet = new Set(reconciled.visibleBuiltInIds)
  return reconciled.rows.map((row) =>
    row.flatMap((id): TerminalAccessoryBarItem<TCustom>[] => {
      const builtInKey = visibleBuiltInSet.has(id) ? builtInById.get(id) : undefined
      const customKey = isCustomAccessoryKeyId(id) ? customById.get(id) : undefined
      return builtInKey
        ? [{ kind: 'built-in', key: builtInKey }]
        : customKey
          ? [{ kind: 'custom', key: customKey }]
          : []
    })
  )
}

export async function loadTerminalAccessoryLayout(): Promise<TerminalAccessoryLayoutPreference> {
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY)
    return raw ? normalizeTerminalAccessoryLayoutPreference(JSON.parse(raw)) : defaultPreference()
  } catch {
    return defaultPreference()
  }
}

export async function saveTerminalAccessoryLayout(layout: TerminalAccessoryLayout): Promise<void> {
  const preference = createTerminalAccessoryLayoutPreference(layout)
  // Through the one write path: the hybrid shell hands this key to the page on every `init`,
  // built synchronously, and what it reads is noted there on an accepted write (ruling 35).
  await persistMirrored(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, JSON.stringify(preference))
}
