import type { MigrationUnsupportedPtyEntry } from '../../shared/agent-status-types'

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

export function clearMigrationUnsupportedPtysForPaneKey(paneKey: string): void {
  for (const [ptyId, entry] of entriesByPtyId) {
    if (entry.paneKey === paneKey) {
      clearMigrationUnsupportedPty(ptyId)
    }
  }
}
