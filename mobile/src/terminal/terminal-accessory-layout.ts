import AsyncStorage from '@react-native-async-storage/async-storage'

import { TERMINAL_ACCESSORY_KEYS, type TerminalAccessoryKey } from './terminal-accessory-keys'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'

export type TerminalAccessoryLayout = {
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
}

export type TerminalAccessoryLayoutPreference = TerminalAccessoryLayout & {
  version: 2
}

function builtInIds(): string[] {
  return TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
}

function defaultPreference(ids = builtInIds()): TerminalAccessoryLayoutPreference {
  return {
    version: 2,
    orderedBuiltInIds: [...ids],
    visibleBuiltInIds: [...ids]
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.every((item): item is string => typeof item === 'string') ? value : null
}

function dedupeKnownIds(ids: string[], builtInSet: Set<string>): string[] {
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

// Why: built-ins added after the user saved a custom order should land next
// to their canonical neighbors, not dangle at the end of the bar.
function insertMissingBuiltInIds(
  ordered: string[],
  currentBuiltInIds: string[]
): { ordered: string[]; inserted: string[] } {
  const present = new Set(ordered)
  const out = [...ordered]
  const inserted: string[] = []
  for (let i = 0; i < currentBuiltInIds.length; i++) {
    const id = currentBuiltInIds[i]!
    if (present.has(id)) {
      continue
    }
    let insertAt = 0
    for (let j = i - 1; j >= 0; j--) {
      const at = out.indexOf(currentBuiltInIds[j]!)
      if (at !== -1) {
        insertAt = at + 1
        break
      }
    }
    out.splice(insertAt, 0, id)
    present.add(id)
    inserted.push(id)
  }
  return { ordered: out, inserted }
}

export function getDefaultTerminalAccessoryBuiltInIds(): string[] {
  return builtInIds()
}

export function getDefaultTerminalAccessoryLayout(): TerminalAccessoryLayout {
  const ids = builtInIds()
  return { orderedBuiltInIds: ids, visibleBuiltInIds: [...ids] }
}

export function normalizeTerminalAccessoryLayoutPreference(
  value: unknown,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  const fallback = defaultPreference(currentBuiltInIds)
  if (!value || typeof value !== 'object') {
    return fallback
  }

  const candidate = value as {
    version?: unknown
    orderedBuiltInIds?: unknown
    visibleBuiltInIds?: unknown
    knownBuiltInIds?: unknown
  }
  const builtInSet = new Set(currentBuiltInIds)

  if (candidate.version === 2) {
    const orderedInput = stringArray(candidate.orderedBuiltInIds)
    const visibleInput = stringArray(candidate.visibleBuiltInIds)
    if (!orderedInput || !visibleInput) {
      return fallback
    }
    const { ordered, inserted } = insertMissingBuiltInIds(
      dedupeKnownIds(orderedInput, builtInSet),
      currentBuiltInIds
    )
    const visibleSet = new Set(dedupeKnownIds(visibleInput, builtInSet))
    for (const id of inserted) {
      visibleSet.add(id)
    }
    return {
      version: 2,
      orderedBuiltInIds: ordered,
      visibleBuiltInIds: ordered.filter((id) => visibleSet.has(id))
    }
  }

  if (candidate.version === 1) {
    const visibleInput = stringArray(candidate.visibleBuiltInIds)
    const knownInput = stringArray(candidate.knownBuiltInIds)
    if (!visibleInput || !knownInput) {
      return fallback
    }
    const knownInputSet = new Set(knownInput.filter((id) => builtInSet.has(id)))
    const visibleSet = new Set(dedupeKnownIds(visibleInput, builtInSet))
    for (const id of currentBuiltInIds) {
      if (!knownInputSet.has(id)) {
        visibleSet.add(id)
      }
    }
    // Why: v1 layouts never had a custom order, so migrate to canonical order.
    return {
      version: 2,
      orderedBuiltInIds: [...currentBuiltInIds],
      visibleBuiltInIds: currentBuiltInIds.filter((id) => visibleSet.has(id))
    }
  }

  return fallback
}

export function createTerminalAccessoryLayoutPreference(
  layout: TerminalAccessoryLayout,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  const builtInSet = new Set(currentBuiltInIds)
  const { ordered } = insertMissingBuiltInIds(
    dedupeKnownIds(layout.orderedBuiltInIds, builtInSet),
    currentBuiltInIds
  )
  const visibleSet = new Set(dedupeKnownIds(layout.visibleBuiltInIds, builtInSet))
  return {
    version: 2,
    orderedBuiltInIds: ordered,
    visibleBuiltInIds: ordered.filter((id) => visibleSet.has(id))
  }
}

export function setTerminalAccessoryBuiltInVisible(
  layout: TerminalAccessoryLayout,
  id: string,
  visible: boolean,
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(layout, currentBuiltInIds)
  if (!new Set(currentBuiltInIds).has(id)) {
    return {
      orderedBuiltInIds: preference.orderedBuiltInIds,
      visibleBuiltInIds: preference.visibleBuiltInIds
    }
  }
  const visibleSet = new Set(preference.visibleBuiltInIds)
  if (visible) {
    visibleSet.add(id)
  } else {
    visibleSet.delete(id)
  }
  return {
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.orderedBuiltInIds.filter((builtInId) => visibleSet.has(builtInId))
  }
}

export function reorderTerminalAccessoryBuiltInIds(
  layout: TerminalAccessoryLayout,
  orderedBuiltInIds: string[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(
    { orderedBuiltInIds, visibleBuiltInIds: layout.visibleBuiltInIds },
    currentBuiltInIds
  )
  return {
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.visibleBuiltInIds
  }
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

export async function loadTerminalAccessoryLayout(): Promise<TerminalAccessoryLayoutPreference> {
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY)
    if (!raw) {
      return defaultPreference()
    }
    return normalizeTerminalAccessoryLayoutPreference(JSON.parse(raw))
  } catch {
    return defaultPreference()
  }
}

export async function saveTerminalAccessoryLayout(layout: TerminalAccessoryLayout): Promise<void> {
  const preference = createTerminalAccessoryLayoutPreference(layout)
  await AsyncStorage.setItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, JSON.stringify(preference))
}
