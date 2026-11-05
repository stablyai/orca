import type { OrchestrationDb } from './db'

/** A Run home that stopped asking this host for its workers' mail is taken as gone after this long. */
const RUN_HOME_LISTENING_MS = 30_000

// Per database, when each Run home last asked; `since` stands in for homes not heard from since it opened,
// so a host restart does not refuse mail while its homes reconnect.
const homes = new WeakMap<OrchestrationDb, { since: number; asked: Map<string, number> }>()

function homesOn(db: OrchestrationDb, now: number): { since: number; asked: Map<string, number> } {
  let entry = homes.get(db)
  if (!entry) {
    entry = { since: now, asked: new Map() }
    homes.set(db, entry)
  }
  return entry
}

export function noteRunHomeAsked(db: OrchestrationDb, homePeerFingerprint: string): void {
  const now = Date.now()
  homesOn(db, now).asked.set(homePeerFingerprint, now)
}

/** Whether a finished worker's mail would still be read, so an unreachable home never leaves it queued. */
export function isRunHomeListening(db: OrchestrationDb, homePeerFingerprint: string): boolean {
  const now = Date.now()
  const entry = homesOn(db, now)
  return now - (entry.asked.get(homePeerFingerprint) ?? entry.since) < RUN_HOME_LISTENING_MS
}
