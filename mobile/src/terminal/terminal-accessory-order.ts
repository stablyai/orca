import type { CustomKey } from '../components/CustomKeyModal'
import { TERMINAL_ACCESSORY_KEYS, type TerminalAccessoryKey } from './terminal-accessory-keys'
import type { TerminalAccessoryLayout } from './terminal-accessory-layout'

const BUILT_IN_PREFIX = 'builtin:'
const CUSTOM_PREFIX = 'custom:'

export type TerminalAccessoryEntry =
  | { id: string; kind: 'builtin'; key: TerminalAccessoryKey }
  | { id: string; kind: 'custom'; key: CustomKey }

export function terminalAccessoryBuiltInOrder(orderedIds: string[]): string[] {
  return orderedIds
    .filter((id) => id.startsWith(BUILT_IN_PREFIX))
    .map((id) => id.slice(BUILT_IN_PREFIX.length))
}

export function normalizeTerminalAccessoryOrder(
  orderedIds: string[],
  orderedBuiltInIds: string[]
): string[] {
  const knownBuiltIns = new Set(orderedBuiltInIds.map((id) => BUILT_IN_PREFIX + id))
  const seen = new Set<string>()
  const result = orderedIds.filter((id) => {
    const custom = id.startsWith(CUSTOM_PREFIX) && id.length > CUSTOM_PREFIX.length
    if ((!knownBuiltIns.has(id) && !custom) || id.includes('\u0000') || seen.has(id)) {
      return false
    }
    seen.add(id)
    return true
  })
  for (const [index, builtInId] of orderedBuiltInIds.entries()) {
    const id = BUILT_IN_PREFIX + builtInId
    if (seen.has(id)) {
      continue
    }
    // Keep leading custom keys in front when a release adds a new first built-in.
    const firstBuiltIn = result.findIndex((entry) => entry.startsWith(BUILT_IN_PREFIX))
    let insertAt = firstBuiltIn === -1 ? result.length : firstBuiltIn
    for (let previous = index - 1; previous >= 0; previous--) {
      const position = result.indexOf(BUILT_IN_PREFIX + orderedBuiltInIds[previous]!)
      if (position !== -1) {
        insertAt = position + 1
        break
      }
    }
    result.splice(insertAt, 0, id)
    seen.add(id)
  }
  return result
}

export function resolveTerminalAccessoryEntries(
  layout: TerminalAccessoryLayout,
  customKeys: CustomKey[]
): TerminalAccessoryEntry[] {
  const entries = new Map<string, TerminalAccessoryEntry>()
  for (const key of TERMINAL_ACCESSORY_KEYS) {
    const id = BUILT_IN_PREFIX + key.id
    entries.set(id, { id, kind: 'builtin', key })
  }
  for (const key of customKeys) {
    const id = CUSTOM_PREFIX + key.id
    if (!entries.has(id)) {
      entries.set(id, { id, kind: 'custom', key })
    }
  }
  const orderedIds = [
    ...(layout.orderedIds ?? []),
    ...layout.orderedBuiltInIds.map((id) => BUILT_IN_PREFIX + id),
    ...customKeys.map((key) => CUSTOM_PREFIX + key.id)
  ]
  const result: TerminalAccessoryEntry[] = []
  for (const id of orderedIds) {
    const entry = entries.get(id)
    if (entry) {
      result.push(entry)
      entries.delete(id)
    }
  }
  return result
}
