import type { OrchestrationDb } from './db'

/** A Run home that stopped asking this host for its workers' mail is taken as gone after this long. */
const RUN_HOME_LISTENING_MS = 30_000

// Per database, when each Run home last asked. A home not heard from since this process started counts from
// the start, so a host restart does not refuse mail while its homes reconnect.
const homes = new WeakMap<OrchestrationDb, Map<string, number>>()

function askedOn(db: OrchestrationDb): Map<string, number> {
  let asked = homes.get(db)
  if (!asked) {
    asked = new Map()
    homes.set(db, asked)
  }
  return asked
}

export function noteRunHomeAsked(db: OrchestrationDb, homePeerFingerprint: string): void {
  askedOn(db).set(homePeerFingerprint, Date.now())
}

/** Whether a finished worker's mail would still be read, so an unreachable home never leaves it queued. */
export function isRunHomeListening(db: OrchestrationDb, homePeerFingerprint: string): boolean {
  const asked = askedOn(db).get(homePeerFingerprint) ?? performance.timeOrigin
  return Date.now() - asked < RUN_HOME_LISTENING_MS
}
