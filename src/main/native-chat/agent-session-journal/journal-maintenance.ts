import type Database from '../../sqlite/sync-database'
import { unrefJournalProjectionTimer } from './journal-saved-state'

export type JournalMaintenanceOwner = {
  through: number
  canCompact: () => boolean
  release: () => void
}
const owners = new WeakMap<Database.Database, Map<string, JournalMaintenanceOwner>>()
export const activeJournalGenerations = new Set<string>()

/** Rebuild and retention share this lease; user appends never acquire it. */
export function ownJournalMaintenance(
  database: Database.Database,
  sessionId: string,
  epoch: string,
  through: number
): JournalMaintenanceOwner | null {
  let held = owners.get(database)
  if (!held) {
    held = new Map()
    owners.set(database, held)
  }
  const key = `${sessionId}\n${epoch}`
  if (held.has(key) || (readers.get(database)?.get(key) ?? 0) > 0) {
    return null
  }
  const registry = held
  const owner = {
    through,
    canCompact: () => (readers.get(database)?.get(key) ?? 0) === 0,
    release: () => {
      if (registry.get(key) === owner) {
        registry.delete(key)
      }
    }
  }
  held.set(key, owner)
  return owner
}

const readers = new WeakMap<Database.Database, Map<string, number>>()

/** A cacheless read can join a repair; a compactor must recheck canCompact on every page. */
export function protectJournalOutcomeRead(
  db: Database.Database,
  sessionId: string,
  epoch: string
): () => void {
  let held = readers.get(db)
  if (!held) {
    held = new Map()
    readers.set(db, held)
  }
  const key = `${sessionId}\n${epoch}`
  const registry = held
  registry.set(key, (registry.get(key) ?? 0) + 1)
  return () => {
    const count = registry.get(key) ?? 0
    if (count <= 1) {
      registry.delete(key)
    } else {
      registry.set(key, count - 1)
    }
  }
}

function createPace(
  now: () => number,
  delay: (ms: number) => Promise<void>
): { work: <T>(unit: () => T) => T; rest: () => Promise<void> } {
  let worked = 0
  let resting: Promise<void> | null = null
  return {
    work<T>(unit: () => T): T {
      const start = now()
      try {
        return unit()
      } finally {
        worked += now() - start
      }
    },
    async rest(): Promise<void> {
      if (resting) {
        await resting
      } else if (worked >= 25) {
        const ms = worked * 9
        worked = 0
        resting = delay(ms).finally(() => {
          resting = null
        })
        await resting
      } else {
        await delay(0)
      }
    }
  }
}

const processPace = createPace(
  () => performance.now(),
  (ms) => new Promise<void>((resolve) => unrefJournalProjectionTimer(setTimeout(resolve, ms)))
)

/** Conversion, cache rebuild, catch-up and reclamation charge one process-wide duty budget. */
export function journalCatchUpPace(
  now?: () => number,
  delay?: (ms: number) => Promise<void>
): ReturnType<typeof createPace> {
  return now && delay ? createPace(now, delay) : processPace
}
