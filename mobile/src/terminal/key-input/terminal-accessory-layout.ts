import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../../storage/mirrored-storage-keys'

import './terminal-accessory-keys'
import type { TerminalAccessoryKey } from './terminal-accessory-keys'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS as TERMINAL_ACCESSORY_KEYS } from './terminal-key-definitions'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'

export type TerminalAccessoryLayout = {
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
  directionPadEnabled?: boolean
  /** Agent keys at the front of the phone's key row; off unless the user turns it on. */
  smartRail?: boolean
}

export type TerminalAccessoryLayoutPreference = TerminalAccessoryLayout & {
  version: 2
}

function builtInIds(): string[] {
  return TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
}

function defaultPreference(
  ids = builtInIds(),
  directionPadAvailable = false
): TerminalAccessoryLayoutPreference {
  return {
    version: 2,
    orderedBuiltInIds: [...ids],
    visibleBuiltInIds: directionPadAvailable
      ? ids.filter((id) => !id.startsWith('arrow'))
      : [...ids],
    directionPadEnabled: true,
    smartRail: false
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

// Place newly added built-ins beside canonical neighbors in saved custom layouts.
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

export function getDefaultTerminalAccessoryLayout(
  directionPadAvailable = false
): TerminalAccessoryLayout {
  const { orderedBuiltInIds, visibleBuiltInIds, directionPadEnabled, smartRail } =
    defaultPreference(builtInIds(), directionPadAvailable)
  return { orderedBuiltInIds, visibleBuiltInIds, directionPadEnabled, smartRail }
}

export function normalizeTerminalAccessoryLayoutPreference(
  value: unknown,
  currentBuiltInIds = builtInIds(),
  directionPadAvailable = false
): TerminalAccessoryLayoutPreference {
  const fallback = defaultPreference(currentBuiltInIds, directionPadAvailable)
  if (!value || typeof value !== 'object') {
    return fallback
  }

  const candidate = {
    version: 'version' in value ? value.version : undefined,
    orderedBuiltInIds: 'orderedBuiltInIds' in value ? value.orderedBuiltInIds : undefined,
    visibleBuiltInIds: 'visibleBuiltInIds' in value ? value.visibleBuiltInIds : undefined,
    knownBuiltInIds: 'knownBuiltInIds' in value ? value.knownBuiltInIds : undefined,
    directionPadEnabled: 'directionPadEnabled' in value ? value.directionPadEnabled : undefined,
    smartRail: 'smartRail' in value ? value.smartRail : undefined
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
      directionPadEnabled: candidate.directionPadEnabled !== false,
      smartRail: candidate.smartRail === true,
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
    // Version-one layouts had no custom order; migrate them to canonical order.
    return {
      version: 2,
      directionPadEnabled: candidate.directionPadEnabled !== false,
      smartRail: candidate.smartRail === true,
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
    directionPadEnabled: layout.directionPadEnabled !== false,
    smartRail: layout.smartRail === true,
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
      directionPadEnabled: preference.directionPadEnabled,
      smartRail: preference.smartRail,
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
    directionPadEnabled: preference.directionPadEnabled,
    smartRail: preference.smartRail,
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
    { ...layout, orderedBuiltInIds },
    currentBuiltInIds
  )
  return {
    directionPadEnabled: preference.directionPadEnabled,
    smartRail: preference.smartRail,
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.visibleBuiltInIds
  }
}

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
