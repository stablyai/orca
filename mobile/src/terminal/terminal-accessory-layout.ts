import AsyncStorage from '@react-native-async-storage/async-storage'

import { TERMINAL_ACCESSORY_KEYS, type TerminalAccessoryKey } from './terminal-accessory-keys'

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'orca:terminal-accessory-layout'

export type TerminalAccessoryLayoutPreference = {
  version: 1
  visibleBuiltInIds: string[]
  knownBuiltInIds: string[]
}

function builtInIds(): string[] {
  return TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
}

function defaultPreference(ids = builtInIds()): TerminalAccessoryLayoutPreference {
  return {
    version: 1,
    visibleBuiltInIds: [...ids],
    knownBuiltInIds: [...ids]
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

function orderBuiltInIds(ids: Set<string>, currentBuiltInIds: string[]): string[] {
  // Why: migrated terminal bars should match the Settings -> Terminal order.
  return currentBuiltInIds.filter((id) => ids.has(id))
}

export function getDefaultTerminalAccessoryBuiltInIds(): string[] {
  return builtInIds()
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
    visibleBuiltInIds?: unknown
    knownBuiltInIds?: unknown
  }
  const visibleInput = stringArray(candidate.visibleBuiltInIds)
  const knownInput = stringArray(candidate.knownBuiltInIds)
  if (candidate.version !== 1 || !visibleInput || !knownInput) {
    return fallback
  }

  const builtInSet = new Set(currentBuiltInIds)
  const knownInputSet = new Set(knownInput.filter((id) => builtInSet.has(id)))
  const visibleBuiltInSet = new Set(dedupeKnownIds(visibleInput, builtInSet))

  for (const id of currentBuiltInIds) {
    if (!knownInputSet.has(id)) {
      visibleBuiltInSet.add(id)
    }
  }

  return {
    version: 1,
    visibleBuiltInIds: orderBuiltInIds(visibleBuiltInSet, currentBuiltInIds),
    knownBuiltInIds: [...currentBuiltInIds]
  }
}

export function createTerminalAccessoryLayoutPreference(
  visibleBuiltInIds: string[],
  currentBuiltInIds = builtInIds()
): TerminalAccessoryLayoutPreference {
  return {
    version: 1,
    visibleBuiltInIds: dedupeKnownIds(visibleBuiltInIds, new Set(currentBuiltInIds)),
    knownBuiltInIds: [...currentBuiltInIds]
  }
}

export function setTerminalAccessoryBuiltInVisible(
  visibleBuiltInIds: string[],
  id: string,
  visible: boolean,
  currentBuiltInIds = builtInIds()
): string[] {
  const builtInSet = new Set(currentBuiltInIds)
  if (!builtInSet.has(id)) {
    return createTerminalAccessoryLayoutPreference(visibleBuiltInIds, currentBuiltInIds)
      .visibleBuiltInIds
  }

  const selected = new Set(dedupeKnownIds(visibleBuiltInIds, builtInSet))
  if (visible) {
    selected.add(id)
  } else {
    selected.delete(id)
  }
  return currentBuiltInIds.filter((builtInId) => selected.has(builtInId))
}

export function resetTerminalAccessoryBuiltInIds(): string[] {
  return builtInIds()
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

export async function saveTerminalAccessoryLayout(visibleBuiltInIds: string[]): Promise<void> {
  const preference = createTerminalAccessoryLayoutPreference(visibleBuiltInIds)
  await AsyncStorage.setItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, JSON.stringify(preference))
}
