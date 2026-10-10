import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { ShadowSeatDirectory } from './shadow-seat-directory.js'

// Step 3: compares the shadow seat map with the database answer on the two
// reads step 5 will serve from memory. It only counts and logs; the database
// answer is always the one returned.

export type ShadowCompareRoute = 'sticky-verify' | 'resolve'

export type ShadowCompareClass =
  | 'agree'
  // Neither the database nor the map has the host.
  | 'agree-absent'
  | 'map-incomplete'
  | 'cell-unpolled'
  | 'db-only-left'
  | 'db-only-unseen'
  | 'cell-mismatch'
  | 'epoch-mismatch'
  | 'duplicate-seat'
  | 'map-only'
  // The map seats the host on a cell the database does not call live, so resolve answered null.
  | 'map-only-cell-unlive'
  // As above, but the cell's heartbeat ran out after the last cell-list read (at most 30 s).
  | 'cell-unlive-pending'

export type ShadowCompareVerdict = { class: ShadowCompareClass; explained: boolean }

export type ShadowCompareDatabaseAnswer = { cellId: string; assignmentEpoch: number } | null

export const SHADOW_COMPARE_FLUSH_MS = 60_000
// One poll, its timeout, and a reconnect (p95 ~6 s on 10-02). A move older than
// this is not "the map catching up": a lost leave must not read as explained forever.
export const SHADOW_COMPARE_LAG_BOUND_MS = 10_000
// Per class per flush window, so a systemic fault cannot flood the log.
export const SHADOW_COMPARE_SAMPLES_PER_CLASS = 10

export function classifyShadowSeat(
  directory: ShadowSeatDirectory,
  identity: { userId: string; relayHostId: string },
  answer: ShadowCompareDatabaseAnswer,
  now: number
): ShadowCompareVerdict {
  // Pure: only ShadowDirectoryCompare records sightings. An epoch never seen is new.
  const movedAt = answer
    ? (directory.databaseEpochFirstSeen(
        identity.userId,
        identity.relayHostId,
        answer.assignmentEpoch
      ) ?? now)
    : now
  if (!directory.isComplete()) return { class: 'map-incomplete', explained: true }
  const seats = directory.seatsOf(identity.userId, identity.relayHostId)
  if (!answer) {
    if (seats.length === 0) return { class: 'agree-absent', explained: true }
    const liveness = seats.map((seat) => directory.cellLiveness(seat.cellId, now))
    if (liveness.includes('unlive')) return { class: 'map-only-cell-unlive', explained: true }
    if (liveness.includes('unknown')) return { class: 'cell-unlive-pending', explained: true }
    return { class: 'map-only', explained: false }
  }
  if (directory.cellState(answer.cellId)?.status !== 'live') {
    return { class: 'cell-unpolled', explained: true }
  }
  if (seats.length > 1) {
    // Inside a drain or rehome grace the old seat is drain-only until it closes.
    return { class: 'duplicate-seat', explained: seats.some((seat) => seat.state === 'drain-only') }
  }
  const seat = seats[0]
  if (!seat) {
    const left = directory
      .recentlyLeftOf(identity.userId, identity.relayHostId, now)
      .some((entry) => entry.cellId === answer.cellId)
    return { class: left ? 'db-only-left' : 'db-only-unseen', explained: true }
  }
  // The map trails the cells by a poll. The database answer carries no grant time, so the
  // move's age is how long this director has seen the newer epoch.
  const mapBehind =
    answer.assignmentEpoch > seat.epoch && now - movedAt <= SHADOW_COMPARE_LAG_BOUND_MS
  if (seat.cellId !== answer.cellId) {
    // A stale seat cell is a coverage gap, kept visible rather than explained away.
    const seatPolledAt = directory.cellState(seat.cellId)?.lastLiveAt ?? 0
    if (now - seatPolledAt > SHADOW_COMPARE_LAG_BOUND_MS) {
      return { class: 'cell-unpolled', explained: true }
    }
    return { class: 'cell-mismatch', explained: mapBehind }
  }
  if (seat.epoch !== answer.assignmentEpoch) {
    return { class: 'epoch-mismatch', explained: mapBehind }
  }
  return { class: 'agree', explained: true }
}

export class ShadowDirectoryCompare {
  private counts = new Map<string, number>()
  private samples = new Map<ShadowCompareClass, number>()
  private windowStartedAt: number

  constructor(
    private readonly directory: ShadowSeatDirectory,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.warn(line)
  ) {
    this.windowStartedAt = now()
  }

  compare(
    route: ShadowCompareRoute,
    identity: { userId: string; relayHostId: string },
    answer: ShadowCompareDatabaseAnswer
  ): ShadowCompareVerdict {
    const now = this.now()
    // Every answer, so a move's age counts from its first sighting on either route.
    if (answer) {
      this.directory.observeDatabaseEpoch(
        identity.userId,
        identity.relayHostId,
        answer.assignmentEpoch,
        now
      )
    }
    const verdict = classifyShadowSeat(this.directory, identity, answer, now)
    const key = `${route}\u0000${verdict.class}\u0000${verdict.explained}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    if (!verdict.explained) this.sample(route, identity, answer, verdict, now)
    if (now - this.windowStartedAt >= SHADOW_COMPARE_FLUSH_MS) this.flush(now)
    return verdict
  }

  // One line per route and class per window; the log metric sums `count`.
  flush(now: number = this.now()): void {
    for (const [key, count] of this.counts) {
      const [route, verdictClass, explained] = key.split('\u0000')
      this.log(
        JSON.stringify({
          event: 'orca_relay_shadow_compare',
          route,
          class: verdictClass,
          explained: explained === 'true',
          count,
          windowMs: now - this.windowStartedAt
        })
      )
    }
    this.counts = new Map()
    this.samples = new Map()
    this.windowStartedAt = now
  }

  private sample(
    route: ShadowCompareRoute,
    identity: { userId: string; relayHostId: string },
    answer: ShadowCompareDatabaseAnswer,
    verdict: ShadowCompareVerdict,
    now: number
  ): void {
    const taken = this.samples.get(verdict.class) ?? 0
    if (taken >= SHADOW_COMPARE_SAMPLES_PER_CLASS) return
    this.samples.set(verdict.class, taken + 1)
    const seats = this.directory.seatsOf(identity.userId, identity.relayHostId)
    this.log(
      JSON.stringify({
        event: 'orca_relay_shadow_compare_unexplained',
        route,
        class: verdict.class,
        host: relayHostLogDigest(identity.relayHostId),
        db: answer ? { cellId: answer.cellId, assignmentEpoch: answer.assignmentEpoch } : null,
        seats: seats.map((seat) => ({
          cellId: seat.cellId,
          epoch: seat.epoch,
          state: seat.state,
          ageMs: now - seat.joinedAt,
          observedAgeMs: now - seat.observedAt
        }))
      })
    )
  }
}
