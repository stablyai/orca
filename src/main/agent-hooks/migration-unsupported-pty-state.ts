import type { MigrationUnsupportedPtyEntry } from '../../shared/agent-status-types'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'

type MigrationUnsupportedPtyEvent =
  | { type: 'set'; entry: MigrationUnsupportedPtyEntry }
  | { type: 'clear'; ptyId: string }

const entriesByPtyId = new Map<string, MigrationUnsupportedPtyEntry>()
export const MIGRATION_UNSUPPORTED_PTY_MAX_ENTRIES = 500
export const MIGRATION_UNSUPPORTED_PTY_MAX_ENTRY_BYTES = 16 * 1024
let listener: ((event: MigrationUnsupportedPtyEvent) => void) | null = null
let persistenceListener: ((entries: MigrationUnsupportedPtyEntry[]) => void) | null = null

export function setMigrationUnsupportedPtyListener(
  nextListener: ((event: MigrationUnsupportedPtyEvent) => void) | null
): void {
  listener = nextListener
}

export function getMigrationUnsupportedPtySnapshot(): MigrationUnsupportedPtyEntry[] {
  return [...entriesByPtyId.values()]
}

export function setMigrationUnsupportedPtyPersistenceListener(
  nextListener: ((entries: MigrationUnsupportedPtyEntry[]) => void) | null
): void {
  persistenceListener = nextListener
}

export function setMigrationUnsupportedPty(entry: MigrationUnsupportedPtyEntry): void {
  try {
    stringifyJsonWithinByteLimit(entry, MIGRATION_UNSUPPORTED_PTY_MAX_ENTRY_BYTES)
  } catch {
    clearMigrationUnsupportedPty(entry.ptyId)
    return
  }
  entriesByPtyId.set(entry.ptyId, entry)
  while (entriesByPtyId.size > MIGRATION_UNSUPPORTED_PTY_MAX_ENTRIES) {
    const oldestPtyId = entriesByPtyId.keys().next().value
    if (oldestPtyId === undefined) {
      break
    }
    entriesByPtyId.delete(oldestPtyId)
    listener?.({ type: 'clear', ptyId: oldestPtyId })
  }
  listener?.({ type: 'set', entry })
  persistenceListener?.(getMigrationUnsupportedPtySnapshot())
}

export function clearMigrationUnsupportedPty(ptyId: string): void {
  if (!entriesByPtyId.delete(ptyId)) {
    return
  }
  listener?.({ type: 'clear', ptyId })
  persistenceListener?.(getMigrationUnsupportedPtySnapshot())
}

export function clearMigrationUnsupportedPtysForPaneKey(paneKey: string): void {
  const ptyIdsToClear: string[] = []
  for (const [ptyId, entry] of entriesByPtyId) {
    if (entry.paneKey === paneKey) {
      ptyIdsToClear.push(ptyId)
    }
  }
  if (ptyIdsToClear.length === 0) {
    return
  }
  // Why: pane teardown can clear several legacy PTYs for one stable pane.
  // Persist once after the batch instead of rebuilding the full snapshot for
  // every entry while still emitting individual renderer clear events.
  for (const ptyId of ptyIdsToClear) {
    entriesByPtyId.delete(ptyId)
    listener?.({ type: 'clear', ptyId })
  }
  persistenceListener?.(getMigrationUnsupportedPtySnapshot())
}

export function clearMigrationUnsupportedPtysByTabPrefix(tabId: string): void {
  const prefix = `${tabId}:`
  const ptyIdsToClear: string[] = []
  for (const [ptyId, entry] of entriesByPtyId) {
    if (entry.paneKey?.startsWith(prefix)) {
      ptyIdsToClear.push(ptyId)
    }
  }
  if (ptyIdsToClear.length === 0) {
    return
  }
  for (const ptyId of ptyIdsToClear) {
    entriesByPtyId.delete(ptyId)
    listener?.({ type: 'clear', ptyId })
  }
  persistenceListener?.(getMigrationUnsupportedPtySnapshot())
}
