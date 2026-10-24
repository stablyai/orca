import type { MigrationUnsupportedPtyEntry } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'

type MigrationUnsupportedPtyEvent =
  | { type: 'set'; entry: MigrationUnsupportedPtyEntry }
  | { type: 'clear'; ptyId: string }

const entriesByPtyId = new Map<string, MigrationUnsupportedPtyEntry>()
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
  entriesByPtyId.set(entry.ptyId, entry)
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

/** Follows a moved pane so a source-tab close, which clears by `S:` prefix, keeps the entry. */
export function rekeyMigrationUnsupportedPtyPaneKey(ptyId: string, toPaneKey: string): void {
  const entry = entriesByPtyId.get(ptyId)
  const owner = parsePaneKey(toPaneKey)
  if (!entry || !owner || entry.paneKey === toPaneKey) {
    return
  }
  setMigrationUnsupportedPty({
    ...entry,
    paneKey: toPaneKey,
    tabId: owner.tabId,
    leafId: owner.leafId
  })
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
  // Batch persistence while still emitting individual renderer clear events.
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
