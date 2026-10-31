import type Database from '../../sqlite/sync-database'
import { unrefJournalProjectionTimer } from './journal-saved-state'

export type JournalMaintenanceOwner = { release: () => void }
const owners = new WeakMap<Database.Database, Set<string>>()

/** Cache rebuild and reclamation share this per-chat lease; user writes never take it. */
export function ownJournalMaintenance(
  database: Database.Database,
  sessionId: string,
  epoch: string
): JournalMaintenanceOwner | null {
  let held = owners.get(database)
  if (!held) {
    held = new Set()
    owners.set(database, held)
  }
  const key = `${sessionId}\n${epoch}`
  if (held.has(key)) {
    return null
  }
  const registry = held
  registry.add(key)
  let released = false
  return {
    release: () => {
      if (!released) {
        released = true
        registry.delete(key)
      }
    }
  }
}

const wakers = new WeakMap<Database.Database, (sessionId: string) => void>()

/** The database's one maintenance runner serves a chat whose saved state lags its writes. */
export function registerJournalMaintenance(
  database: Database.Database,
  wake: (sessionId: string) => void
): () => void {
  wakers.set(database, wake)
  return () => {
    if (wakers.get(database) === wake) {
      wakers.delete(database)
    }
  }
}

export function requestJournalMaintenance(database: Database.Database, sessionId: string): void {
  wakers.get(database)?.(sessionId)
}

export type JournalPace = { work: <T>(unit: () => T) => T; rest: () => Promise<void> }

/** A 10% duty cycle for background maintenance only: a chat open or a send is never charged. */
export function createJournalPace(
  now: () => number,
  delay: (ms: number) => Promise<void>
): JournalPace {
  let worked = 0
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
      const ms = worked >= 25 ? worked * 9 : 0
      if (ms > 0) {
        worked = 0
      }
      await delay(ms)
    }
  }
}

export function journalMaintenanceDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => unrefJournalProjectionTimer(setTimeout(resolve, ms)))
}
