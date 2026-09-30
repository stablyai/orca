import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import type { CustomKey } from '../components/CustomKeyModal'

import { TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'
import {
  normalizeTerminalAccessoryOrder,
  resolveTerminalAccessoryEntries,
  terminalAccessoryBuiltInOrder,
  type TerminalAccessoryEntry
} from './terminal-accessory-order'

export type { TerminalAccessoryEntry } from './terminal-accessory-order'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'

export type TerminalAccessoryLayout = {
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
  orderedIds?: string[]
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

function withTerminalAccessoryOrder(
  layout: TerminalAccessoryLayout,
  value: unknown
): TerminalAccessoryLayout {
  const input = stringArray(value)
  if (!input) {
    return layout
  }
  const orderedIds = normalizeTerminalAccessoryOrder(input, layout.orderedBuiltInIds)
  const orderedBuiltInIds = terminalAccessoryBuiltInOrder(orderedIds)
  const visible = new Set(layout.visibleBuiltInIds)
  return {
    orderedIds,
    orderedBuiltInIds,
    visibleBuiltInIds: orderedBuiltInIds.filter((id) => visible.has(id))
  }
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

  const candidate = {
    version: 'version' in value ? value.version : undefined,
    orderedBuiltInIds: 'orderedBuiltInIds' in value ? value.orderedBuiltInIds : undefined,
    orderedIds: 'orderedIds' in value ? value.orderedIds : undefined,
    visibleBuiltInIds: 'visibleBuiltInIds' in value ? value.visibleBuiltInIds : undefined,
    knownBuiltInIds: 'knownBuiltInIds' in value ? value.knownBuiltInIds : undefined
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
      ...withTerminalAccessoryOrder(
        {
          orderedBuiltInIds: ordered,
          visibleBuiltInIds: ordered.filter((id) => visibleSet.has(id))
        },
        candidate.orderedIds
      )
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
    ...withTerminalAccessoryOrder(
      { orderedBuiltInIds: ordered, visibleBuiltInIds: ordered.filter((id) => visibleSet.has(id)) },
      layout.orderedIds
    )
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
      visibleBuiltInIds: preference.visibleBuiltInIds,
      ...(preference.orderedIds ? { orderedIds: preference.orderedIds } : {})
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
    visibleBuiltInIds: preference.orderedBuiltInIds.filter((builtInId) =>
      visibleSet.has(builtInId)
    ),
    ...(preference.orderedIds ? { orderedIds: preference.orderedIds } : {})
  }
}

export function reorderTerminalAccessoryIds(
  layout: TerminalAccessoryLayout,
  orderedIds: string[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(
    {
      orderedBuiltInIds: terminalAccessoryBuiltInOrder(orderedIds),
      visibleBuiltInIds: layout.visibleBuiltInIds,
      orderedIds
    },
    currentBuiltInIds
  )
  return {
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.visibleBuiltInIds,
    orderedIds: preference.orderedIds
  }
}

export function getTerminalAccessoryEntries(
  layout: TerminalAccessoryLayout,
  customKeys: CustomKey[]
): TerminalAccessoryEntry[] {
  return resolveTerminalAccessoryEntries(
    createTerminalAccessoryLayoutPreference(layout),
    customKeys
  )
}

export function resetTerminalAccessoryLayout(
  layout: TerminalAccessoryLayout,
  customKeys: CustomKey[]
): TerminalAccessoryLayout {
  const defaults = getDefaultTerminalAccessoryLayout()
  // Custom-key storage may still be loading when Reset is pressed.
  const customOrder = [
    ...(layout.orderedIds ?? []).filter((id) => id.startsWith('custom:')),
    ...customKeys.map((key) => `custom:${key.id}`)
  ]
  return {
    ...defaults,
    orderedIds: normalizeTerminalAccessoryOrder(
      [...defaults.orderedBuiltInIds.map((id) => `builtin:${id}`), ...customOrder],
      defaults.orderedBuiltInIds
    )
  }
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
  const value = JSON.stringify(preference)
  // Through the one write path: the hybrid shell hands this key to the page on every `init`,
  // built synchronously, and what it reads is noted there on an accepted write (ruling 35).
  await persistMirrored(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, value)
}
