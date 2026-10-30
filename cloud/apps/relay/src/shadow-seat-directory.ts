import type { RelayRegion } from '@orca-cloud/relay-contract'
import { z } from 'zod'
import {
  CellPollReachability,
  type DeadCellVerdict,
  isNoBackendStatus
} from './cell-poll-reachability.js'
import type { RelayConfig } from './config.js'
import { googleMetadataIdentityToken, reusedIdentityToken } from './google-metadata-identity-token.js'

// Each director mirrors cell seat feeds; callbacks reconcile booked joins and superseded seats.

export const SHADOW_SEAT_POLL_MS = 1_000
export const SHADOW_SEAT_POLL_TIMEOUT_MS = 2_000
export const SHADOW_SEAT_CELL_LIST_REFRESH_MS = 30_000
export const SHADOW_SEAT_RECENTLY_LEFT_TTL_MS = 24 * 60 * 60 * 1_000
export const SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS = 100_000
// Cells stamp joinedAt by their own clocks: a later join must clear this to outrank across cells.
export const SHADOW_SEAT_OUTRANK_SKEW_MS = 1_000
const SHADOW_SEAT_OUTRANKED_REPORTS_MAX = 100_000

export function seatOutranks(
  newer: { epoch: number; joinedAt: number },
  seat: { epoch: number; joinedAt: number }
): boolean {
  return newer.epoch > seat.epoch && newer.joinedAt > seat.joinedAt + SHADOW_SEAT_OUTRANK_SKEW_MS
}
const RECENTLY_LEFT_PER_HOST = 4
// Google identity tokens live an hour; one per poll would be 26 metadata reads a second.
const IDENTITY_TOKEN_REUSE_MS = 10 * 60_000
const SUMMARY_INTERVAL_MS = 60_000
const WITHHELD_LOG_INTERVAL_MS = 60_000
const CELL_LIST_RETRY_BASE_MS = 1_000
const CELL_LIST_RETRY_MAX_MS = SHADOW_SEAT_CELL_LIST_REFRESH_MS
// A drain backlog drains over a few polls rather than holding one slot indefinitely.
const MAX_PAGES_PER_POLL = 5

// Lenient on purpose: a newer cell may add fields or change kinds.
const SeatChangeSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.string(),
  userId: z.string(),
  relayHostId: z.string(),
  epoch: z.number().int(),
  generation: z.number().int(),
  state: z.string().optional(),
  closeCode: z.number().int().optional(),
  // Step 5: on `reserve`, and on the join a booking admitted.
  reservedBy: z.string().optional(),
  at: z.number()
})
const RecentlyLeftSchema = z.object({
  userId: z.string(),
  relayHostId: z.string(),
  epoch: z.number().int(),
  closeCode: z.number().int().optional(),
  at: z.number()
})
const SeatSchema = z.object({
  userId: z.string(),
  relayHostId: z.string(),
  epoch: z.number().int(),
  generation: z.number().int(),
  state: z.string(),
  joinedAt: z.number()
})
const SeatFeedSchema = z.object({
  v: z.literal(1),
  cellId: z.string(),
  incarnation: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: z.number(),
  draining: z.boolean().optional(),
  counts: z
    .object({
      // Seats in the cell's own log, under the same generation rule: equals the map exactly.
      seats: z.number().int().nonnegative(),
      // Drops at the start of a close handshake, up to ~30 s before the leave lands.
      controls: z.number().int().nonnegative(),
      // Step 5: live bookings, every unit the cell's ledger counts, and its placement ceiling.
      bookings: z.number().int().nonnegative(),
      units: z.number().int().nonnegative(),
      ceiling: z.number().int().nonnegative()
    })
    .partial()
    .optional(),
  intake: z
    .object({ perSec: z.number().nonnegative(), burst: z.number(), tokens: z.number() })
    .optional(),
  flagsApplied: z
    .object({ generation: z.union([z.string(), z.number()]), flags: z.record(z.string(), z.unknown()) })
    .optional(),
  // Effective reserve persists while flip-back leases controls; raw mode reports dead-man db immediately. Older images omit both.
  admitModeEffective: z.enum(['db', 'reserve']).optional(),
  // Switch file and dead-man only, without the flip back: db the moment the cell trips.
  admitModeRaw: z.enum(['db', 'reserve']).optional(),
  changes: z.array(SeatChangeSchema).optional(),
  // The cell cut the page (2,000 changes); poll again at once.
  more: z.boolean().optional(),
  full: z.array(SeatSchema).optional(),
  // Step 5, with `full`: the cell's leavers of the last 10 minutes.
  recentlyLeft: z.array(RecentlyLeftSchema).optional()
})
export type SeatFeedResponse = z.infer<typeof SeatFeedSchema>

export type SeatFeedCell = {
  cellId: string
  cellUrl: string
  region: RelayRegion
  // When placement's liveness rule stops calling this cell live; null when not ready.
  heartbeatExpiresAt: number | null
  // Live, with capacity, and not roll-isolated: completeness waits only on these.
  requiredForComplete: boolean
  // relay_cell_runtime's: a new one means the process that reported its switches is gone.
  incarnation?: string
  // Admission state general and not roll-isolated: step 5 places only on these.
  general?: boolean
  // Zero for a row that can hold no host; absent from callers that do not read it.
  capacityRequests?: number
}

export type ShadowSeat = {
  cellId: string
  epoch: number
  generation: number
  // 'active' or 'drain-only'; a newer cell may report other states.
  state: string
  joinedAt: number
  observedAt: number
  // The cell incarnation that reported it: a restart since means the cell forgot it.
  incarnation?: string
}

export type RecentlyLeftSeat = {
  cellId: string
  epoch: number
  generation: number
  incarnation?: string
  closeCode?: number
  // A full resync dropped the seat, so no close code was seen.
  resync?: true
  at: number
}

// Loss of contact is never evidence the seats are gone: `unverifiable` keeps them.
export type SeatFeedCellStatus = 'pending' | 'live' | 'unverifiable' | 'no-feed'

export type SeatFeedCellState = {
  cellId: string
  status: SeatFeedCellStatus
  incarnation?: string
  seq?: number
  lastAnsweredAt?: number
  lastLiveAt?: number
  lastFailure?: string
  draining?: boolean
  reportedSeats?: number
  reportedControls?: number
  flagsApplied?: SeatFeedResponse['flagsApplied']
  // The incarnation whose feed reported `flagsApplied`.
  flagsIncarnation?: string
  admitModeEffective?: 'db' | 'reserve'
  admitModeRaw?: 'db' | 'reserve'
  // Step 5: when the answered poll was sent, and the cell's own reserve numbers.
  polledAt?: number
  bookings?: number
  units?: number
  ceiling?: number
  intake?: SeatFeedResponse['intake']
}

// A join a booking admitted, for the director that booked it (its after-the-fact row).
export type BookedJoin = {
  cellId: string
  userId: string
  relayHostId: string
  epoch: number
  generation: number
  joinedAt: number
  reservedBy: string
}

// A reserve seat behind a later, newer-epoch join of its host elsewhere that placement supersede missed.
export type OutrankedSeat = {
  cellId: string
  userId: string
  relayHostId: string
  epoch: number
  joinedAt: number
  byCellId: string
}

type CellCursor = SeatFeedCellState & { seats: Map<string, ShadowSeat> }

export type HeartbeatSnapshot = { readAt: number; expiresAt: ReadonlyMap<string, number> }

function hostKey(userId: string, relayHostId: string): string {
  return `${userId}\u0000${relayHostId}`
}

function parseHostKey(key: string): { userId: string; relayHostId: string } {
  const separator = key.indexOf('\u0000')
  return { userId: key.slice(0, separator), relayHostId: key.slice(separator + 1) }
}

export class ShadowSeatDirectory {
  private readonly cells = new Map<string, CellCursor>()
  private readonly hosts = new Map<string, Map<string, ShadowSeat>>()
  // Insertion order is age order: a touched host is re-inserted at the end.
  private readonly recentlyLeft = new Map<string, RecentlyLeftSeat[]>()
  private required = new Set<string>()
  // Absent: every listed cell is live (callers without a database view).
  private heartbeats: HeartbeatSnapshot | undefined
  // Per host, the newest database epoch seen and when: stands in for the grant time.
  private readonly databaseEpochs = new Map<string, { epoch: number; firstSeenAt: number }>()
  // Per host, the newest booking any cell reported (step 5 epoch mint). Age-ordered.
  private readonly bookings = new Map<string, { cellId: string; epoch: number; at: number }>()
  onBookedJoin?: (join: BookedJoin) => void
  onOutranked?: (seat: OutrankedSeat) => void
  private readonly joinedSinceApply = new Set<string>()
  // Seats already reported, insertion-ordered: a full resync re-judges a host without a second demote.
  private readonly reportedOutranked = new Set<string>()

  // Cells no longer listed are forgotten with their seats; new ones start pending.
  // `required` defaults to every listed cell.
  setCells(
    cellIds: readonly string[],
    required: Iterable<string> = cellIds,
    heartbeats?: HeartbeatSnapshot
  ): void {
    const wanted = new Set(cellIds)
    this.required = new Set([...required].filter((cellId) => wanted.has(cellId)))
    this.heartbeats = heartbeats
    for (const [cellId, cursor] of this.cells) {
      if (wanted.has(cellId)) continue
      for (const key of cursor.seats.keys()) this.unindex(key, cellId)
      this.cells.delete(cellId)
    }
    for (const cellId of wanted) {
      if (!this.cells.has(cellId)) {
        this.cells.set(cellId, { cellId, status: 'pending', seats: new Map() })
      }
    }
  }

  // The `since` cursor for the next poll, or undefined to ask for a full snapshot.
  since(cellId: string): string | undefined {
    const cursor = this.cells.get(cellId)
    if (cursor?.incarnation === undefined || cursor.seq === undefined) return undefined
    return `${cursor.incarnation}:${cursor.seq}`
  }

  // `polledAt` is when the request left; the reply holds every change before it.
  apply(cellId: string, response: SeatFeedResponse, now: number, polledAt = now): void {
    this.applyResponse(cellId, response, now, polledAt)
    this.reportOutranked()
  }

  private applyResponse(cellId: string, response: SeatFeedResponse, now: number, polledAt: number): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    if (response.cellId !== cellId) {
      this.fail(cellId, 'cell_id_mismatch')
      return
    }
    let seq: number | null = response.seq
    if (response.full) {
      this.replaceSeats(cursor, response.full, now, response.incarnation)
      for (const left of response.recentlyLeft ?? []) {
        const key = hostKey(left.userId, left.relayHostId)
        if (cursor.seats.has(key)) continue
        this.rememberLeft(key, {
          cellId,
          epoch: left.epoch,
          generation: 0,
          incarnation: response.incarnation,
          ...(left.closeCode === undefined ? {} : { closeCode: left.closeCode }),
          at: left.at
        })
      }
    } else {
      seq =
        cursor.incarnation === response.incarnation
          ? this.applyChanges(cursor, response.changes ?? [], now)
          : null
      // A delta against a cursor we do not hold cannot be trusted: resync.
      if (seq === null || (seq < response.seq && (response.changes ?? []).length === 0)) {
        cursor.incarnation = undefined
        cursor.seq = undefined
        this.fail(cellId, 'cursor_gap')
        return
      }
    }
    cursor.incarnation = response.incarnation
    // A page shorter than the cell's head resumes from its last change.
    cursor.seq = seq
    cursor.status = 'live'
    cursor.lastAnsweredAt = now
    cursor.lastLiveAt = now
    cursor.lastFailure = undefined
    cursor.draining = response.draining
    cursor.reportedSeats = response.counts?.seats
    cursor.reportedControls = response.counts?.controls
    cursor.flagsApplied = response.flagsApplied
    cursor.flagsIncarnation = response.incarnation
    cursor.admitModeEffective = response.admitModeEffective
    cursor.admitModeRaw = response.admitModeRaw
    cursor.polledAt = polledAt
    cursor.bookings = response.counts?.bookings
    cursor.units = response.counts?.units
    cursor.ceiling = response.counts?.ceiling
    cursor.intake = response.intake
  }

  // The newest booking any cell reported for this host since this director started.
  bookingOf(userId: string, relayHostId: string): { cellId: string; epoch: number } | undefined {
    return this.bookings.get(hostKey(userId, relayHostId))
  }

  // Applied state only: what the cell last said its switch is, never the desired object.
  admitModeOf(cellId: string): 'db' | 'reserve' {
    const cursor = this.cells.get(cellId)
    if (cursor?.admitModeEffective) return cursor.admitModeEffective
    return cursor?.flagsApplied?.flags.admitMode === 'reserve' ? 'reserve' : 'db'
  }

  // Raw db stops bookings/pacing immediately during re-registration; older images fall back to effective mode.
  placementModeOf(cellId: string): 'db' | 'reserve' {
    const raw = this.cells.get(cellId)?.admitModeRaw
    return raw ?? this.admitModeOf(cellId)
  }

  cellIds(): string[] {
    return [...this.cells.keys()]
  }

  seatsOnCell(cellId: string): Array<{ userId: string; relayHostId: string; seat: ShadowSeat }> {
    const cursor = this.cells.get(cellId)
    if (!cursor) return []
    return [...cursor.seats].map(([key, seat]) => ({ ...parseHostKey(key), seat }))
  }

  // An old cell (404) has no feed; its last known seats stay, marked by status.
  markNoFeed(cellId: string, now: number, runtimeIncarnation?: string): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    cursor.status = 'no-feed'
    cursor.lastAnsweredAt = now
    cursor.incarnation = undefined
    cursor.seq = undefined
    // An image without the feed takes no booking.
    cursor.polledAt = undefined
    cursor.bookings = undefined
    cursor.units = undefined
    cursor.ceiling = undefined
    cursor.intake = undefined
    // Keep reserve stamp until feed says db or process changes; one 404 must not misclassify seated reserve hosts as idle.
    const reserve = cursor.flagsApplied?.flags.admitMode === 'reserve'
    const replaced =
      runtimeIncarnation !== undefined && runtimeIncarnation !== cursor.flagsIncarnation
    if (!reserve || replaced) {
      cursor.flagsApplied = undefined
      cursor.flagsIncarnation = undefined
      cursor.admitModeEffective = undefined
      cursor.admitModeRaw = undefined
    }
  }

  fail(cellId: string, reason: string): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    if (cursor.status !== 'pending' && cursor.status !== 'no-feed') cursor.status = 'unverifiable'
    cursor.lastFailure = reason
  }

  // Completeness waits only for required live cells’ feed/404 answers, not dead/empty/isolated cells.
  isComplete(): boolean {
    if (this.required.size === 0) return false
    for (const cellId of this.required) {
      if (this.cells.get(cellId)?.lastAnsweredAt === undefined) return false
    }
    return true
  }

  // Database liveness from <=30s-old cell list; expired-since-read heartbeat is unknown pending refresh.
  cellLiveness(cellId: string, now: number): 'live' | 'unlive' | 'unknown' {
    if (!this.heartbeats) return this.cells.has(cellId) ? 'live' : 'unlive'
    const expiresAt = this.heartbeats.expiresAt.get(cellId)
    if (expiresAt === undefined) return 'unlive'
    if (expiresAt > now) return 'live'
    return expiresAt > this.heartbeats.readAt ? 'unknown' : 'unlive'
  }

  // When this director first saw the host at this database epoch, if it has.
  databaseEpochFirstSeen(userId: string, relayHostId: string, epoch: number): number | undefined {
    const known = this.databaseEpochs.get(hostKey(userId, relayHostId))
    return known && known.epoch >= epoch ? known.firstSeenAt : undefined
  }

  // The newest epoch this director has seen the database name for the host, if still kept.
  databaseEpochOf(
    userId: string,
    relayHostId: string
  ): { epoch: number; firstSeenAt: number } | undefined {
    const known = this.databaseEpochs.get(hostKey(userId, relayHostId))
    return known ? { ...known } : undefined
  }

  // Records a sighting; returns when this director first saw the host at this epoch.
  observeDatabaseEpoch(userId: string, relayHostId: string, epoch: number, now: number): number {
    const key = hostKey(userId, relayHostId)
    const known = this.databaseEpochs.get(key)
    if (known && known.epoch >= epoch) return known.firstSeenAt
    this.databaseEpochs.delete(key)
    this.databaseEpochs.set(key, { epoch, firstSeenAt: now })
    if (this.databaseEpochs.size > SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS) {
      const oldest = this.databaseEpochs.keys().next().value
      if (oldest !== undefined) this.databaseEpochs.delete(oldest)
    }
    return now
  }

  seatsOf(userId: string, relayHostId: string): ShadowSeat[] {
    return [...(this.hosts.get(hostKey(userId, relayHostId))?.values() ?? [])]
  }

  // Users the map has seen with this host id; a linear scan, for admin reads only.
  userIdsOf(relayHostId: string): string[] {
    const suffix = `\u0000${relayHostId}`
    const userIds = new Set<string>()
    for (const keys of [this.hosts.keys(), this.recentlyLeft.keys()]) {
      for (const key of keys) {
        if (key.endsWith(suffix)) userIds.add(key.slice(0, -suffix.length))
      }
    }
    return [...userIds].sort()
  }

  recentlyLeftOf(userId: string, relayHostId: string, now: number): RecentlyLeftSeat[] {
    return (this.recentlyLeft.get(hostKey(userId, relayHostId)) ?? []).filter(
      (entry) => entry.at > now - SHADOW_SEAT_RECENTLY_LEFT_TTL_MS
    )
  }

  cellState(cellId: string): SeatFeedCellState | undefined {
    const cursor = this.cells.get(cellId)
    if (!cursor) return undefined
    const { seats: _seats, ...state } = cursor
    return state
  }

  summary(now: number) {
    const statuses: Record<SeatFeedCellStatus, number> = {
      pending: 0,
      live: 0,
      unverifiable: 0,
      'no-feed': 0
    }
    let seats = 0
    let seatsMismatchedCells = 0
    let controlsBelowMapCells = 0
    let oldestLiveAgeMs = 0
    for (const cursor of this.cells.values()) {
      statuses[cursor.status] += 1
      seats += cursor.seats.size
      if (cursor.status === 'live') {
        const seatCount = cursor.seats.size
        if (cursor.reportedSeats !== undefined && cursor.reportedSeats !== seatCount) {
          seatsMismatchedCells += 1
        }
        // A cross-check only: closing sockets keep it briefly below the map.
        const controls = cursor.reportedControls
        if (controls !== undefined && controls < seatCount) controlsBelowMapCells += 1
        oldestLiveAgeMs = Math.max(oldestLiveAgeMs, now - (cursor.lastLiveAt ?? now))
      }
    }
    return {
      cells: this.cells.size,
      statuses,
      seats,
      hosts: this.hosts.size,
      recentlyLeftHosts: this.recentlyLeft.size,
      seatsMismatchedCells,
      controlsBelowMapCells,
      oldestLiveAgeMs,
      complete: this.isComplete()
    }
  }

  private applyChanges(
    cursor: CellCursor,
    changes: SeatFeedResponse['changes'] & object,
    now: number
  ): number | null {
    let seq = cursor.seq ?? 0
    for (const change of changes) {
      if (change.seq <= seq) continue
      if (change.seq !== seq + 1) return null
      seq = change.seq
      const key = hostKey(change.userId, change.relayHostId)
      // A booking is not a seat and carries no generation.
      if (change.kind === 'reserve') {
        this.rememberBooking(key, cursor.cellId, change.epoch, change.at)
        continue
      }
      const seat = cursor.seats.get(key)
      // A superseded generation's leave can arrive after its successor's join.
      if (seat && change.generation < seat.generation) continue
      if (change.kind === 'join') {
        this.seat(cursor, key, {
          cellId: cursor.cellId,
          epoch: change.epoch,
          generation: change.generation,
          state: change.state ?? 'active',
          joinedAt: change.at,
          observedAt: now,
          incarnation: cursor.incarnation
        })
        if (change.reservedBy !== undefined) {
          this.onBookedJoin?.({
            cellId: cursor.cellId,
            userId: change.userId,
            relayHostId: change.relayHostId,
            epoch: change.epoch,
            generation: change.generation,
            joinedAt: change.at,
            reservedBy: change.reservedBy
          })
        }
      } else if (change.kind === 'leave') {
        if (seat) {
          this.unseat(cursor, key)
          this.rememberLeft(key, {
            cellId: cursor.cellId,
            epoch: change.epoch,
            generation: change.generation,
            incarnation: cursor.incarnation,
            closeCode: change.closeCode,
            at: change.at
          })
        }
      } else if (change.kind === 'drain-only' || change.kind === 'active') {
        // `active`: a token refresh lifted an auth-expiry drain-only.
        if (seat) {
          seat.state = change.kind
          seat.observedAt = now
        }
      }
    }
    return seq
  }

  private replaceSeats(
    cursor: CellCursor,
    full: SeatFeedResponse['full'] & object,
    now: number,
    incarnation: string
  ) {
    const next = new Map<string, ShadowSeat>()
    for (const seat of full) {
      next.set(hostKey(seat.userId, seat.relayHostId), {
        cellId: cursor.cellId,
        epoch: seat.epoch,
        generation: seat.generation,
        state: seat.state,
        joinedAt: seat.joinedAt,
        observedAt: now,
        incarnation
      })
    }
    for (const [key, seat] of cursor.seats) {
      if (next.has(key)) continue
      this.unseat(cursor, key)
      this.rememberLeft(key, {
        cellId: cursor.cellId,
        epoch: seat.epoch,
        generation: seat.generation,
        ...(seat.incarnation === undefined ? {} : { incarnation: seat.incarnation }),
        resync: true,
        at: now
      })
    }
    for (const [key, seat] of next) this.seat(cursor, key, seat)
  }

  private seat(cursor: CellCursor, key: string, seat: ShadowSeat): void {
    cursor.seats.set(key, seat)
    let seats = this.hosts.get(key)
    if (!seats) {
      seats = new Map()
      this.hosts.set(key, seats)
    }
    seats.set(cursor.cellId, seat)
    if (this.onOutranked && seats.size > 1) this.joinedSinceApply.add(key)
  }

  // Judge after full response applies mode, once per join. Later reserve flips/lost demotes/later lower epochs rely on silence close or reconcile.
  private reportOutranked(): void {
    const report = this.onOutranked
    const keys = [...this.joinedSinceApply]
    this.joinedSinceApply.clear()
    if (!report) return
    for (const key of keys) {
      const seats = [...(this.hosts.get(key)?.values() ?? [])]
      for (const seat of seats) {
        if (seat.state !== 'active' || this.admitModeOf(seat.cellId) !== 'reserve') continue
        const by = seats.find((other) => seatOutranks(other, seat))
        if (!by) continue
        const { cellId, epoch, joinedAt } = seat
        const reported = `${key}\u0000${cellId}\u0000${epoch}\u0000${joinedAt}`
        if (this.reportedOutranked.has(reported)) continue
        this.reportedOutranked.add(reported)
        if (this.reportedOutranked.size > SHADOW_SEAT_OUTRANKED_REPORTS_MAX) {
          const oldest = this.reportedOutranked.values().next().value
          if (oldest !== undefined) this.reportedOutranked.delete(oldest)
        }
        report({ ...parseHostKey(key), cellId, epoch, joinedAt, byCellId: by.cellId })
      }
    }
  }

  private unseat(cursor: CellCursor, key: string): void {
    cursor.seats.delete(key)
    this.unindex(key, cursor.cellId)
  }

  private unindex(key: string, cellId: string): void {
    const seats = this.hosts.get(key)
    if (!seats) return
    seats.delete(cellId)
    if (seats.size === 0) this.hosts.delete(key)
  }

  private rememberBooking(key: string, cellId: string, epoch: number, at: number): void {
    const known = this.bookings.get(key)
    if (known && known.epoch > epoch) return
    this.bookings.delete(key)
    this.bookings.set(key, { cellId, epoch, at })
    if (this.bookings.size > SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS) {
      const oldest = this.bookings.keys().next().value
      if (oldest !== undefined) this.bookings.delete(oldest)
    }
  }

  private rememberLeft(key: string, entry: RecentlyLeftSeat): void {
    const entries = this.recentlyLeft.get(key) ?? []
    this.recentlyLeft.delete(key)
    entries.push(entry)
    if (entries.length > RECENTLY_LEFT_PER_HOST) {
      entries.splice(0, entries.length - RECENTLY_LEFT_PER_HOST)
    }
    this.recentlyLeft.set(key, entries)
    const cutoff = entry.at - SHADOW_SEAT_RECENTLY_LEFT_TTL_MS
    for (const [oldestKey, oldest] of this.recentlyLeft) {
      const newest = oldest[oldest.length - 1]
      const withinBound = this.recentlyLeft.size <= SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS
      if (withinBound && newest && newest.at > cutoff) break
      this.recentlyLeft.delete(oldestKey)
    }
  }
}

export type ShadowSeatPollerOptions = {
  listCells: () => Promise<SeatFeedCell[]>
  fetch?: typeof fetch
  identityToken?: (audience: string) => Promise<string>
  now?: () => number
  pollMs?: number
  log?: (line: string) => void
  // True while this director places on reserve cells (ORCA_RELAY_RESERVE_PLACEMENT=on).
  reserver?: () => boolean
}

export type ShadowSeatPoller = {
  directory: ShadowSeatDirectory
  // The cell list as last read: url, region, liveness and admission.
  cells: () => readonly SeatFeedCell[]
  // When the poller started, for the startup gate.
  startedAt: number
  // One round: refreshes the cell list when due, then polls every idle cell.
  tick: () => Promise<void>
  // This director's polls to the cell have gone unanswered long enough to count as death evidence;
  // null while they are answered.
  deadCellVerdict: (cellId: string, now: number) => DeadCellVerdict | null
  stop: () => void
}

// Null unless this is a director with the rehome credential and at least one cell switched on.
export function startShadowSeatPoller(
  config: Pick<RelayConfig, 'role' | 'rehomeAudience' | 'shadowSeatFeedCells'>,
  options: ShadowSeatPollerOptions
): ShadowSeatPoller | null {
  const selection = config.shadowSeatFeedCells
  if (
    config.role !== 'director' ||
    !config.rehomeAudience ||
    selection === undefined ||
    (selection !== 'all' && selection.length === 0)
  ) {
    return null
  }
  const audience = config.rehomeAudience
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(line))
  const tokenProvider =
    options.identityToken ??
    ((tokenAudience: string) => googleMetadataIdentityToken(tokenAudience, fetchImpl))
  const directory = new ShadowSeatDirectory()
  const reachability = new CellPollReachability()
  const withheldLoggedAt = new Map<string, number>()
  const startedAt = now()
  const inFlight = new Set<string>()
  let cells: SeatFeedCell[] = []
  let cellsReadAt: number | undefined
  let cellListInFlight = false
  let cellListFailures = 0
  let cellListRetryAt = 0
  let lastSummaryAt = now()
  let stopped = false

  const identity = reusedIdentityToken(() => tokenProvider(audience), now, IDENTITY_TOKEN_REUSE_MS)

  const refreshCells = async (): Promise<void> => {
    if (cellListInFlight) return
    if (cellsReadAt !== undefined && now() - cellsReadAt < SHADOW_SEAT_CELL_LIST_REFRESH_MS) return
    if (now() < cellListRetryAt) return
    cellListInFlight = true
    try {
      const readAt = now()
      const listed = await options.listCells()
      cells =
        selection === 'all' ? listed : listed.filter((cell) => selection.includes(cell.cellId))
      directory.setCells(
        cells.map((cell) => cell.cellId),
        cells.filter((cell) => cell.requiredForComplete).map((cell) => cell.cellId),
        {
          readAt,
          expiresAt: new Map(
            cells.flatMap((cell) =>
              cell.heartbeatExpiresAt === null ? [] : [[cell.cellId, cell.heartbeatExpiresAt]]
            )
          )
        }
      )
      reachability.forget(new Set(cells.map((cell) => cell.cellId)))
      cellsReadAt = now()
      cellListFailures = 0
    } catch (error) {
      // Keep polling last list through DB outages; back off refreshes to protect the three-connection pool.
      cellListFailures += 1
      const backoffMs = CELL_LIST_RETRY_BASE_MS * 2 ** (cellListFailures - 1)
      cellListRetryAt = now() + Math.min(CELL_LIST_RETRY_MAX_MS, backoffMs)
      log(
        JSON.stringify({
          event: 'orca_relay_shadow_seat_cell_list_failed',
          failures: cellListFailures,
          reason: error instanceof Error ? error.message : 'unknown'
        })
      )
    } finally {
      cellListInFlight = false
    }
  }

  // Returns true when the cell cut the page and the next one should follow at once.
  const fetchPage = async (cell: SeatFeedCell): Promise<boolean> => {
    const url = new URL('/v1/admin/cell-seats', cell.cellUrl)
    const polledAt = now()
    const since = directory.since(cell.cellId)
    if (since !== undefined) url.searchParams.set('since', since)
    // Placing on reserve cells: keeps each cell's dead-man from flipping it back to db.
    if (options.reserver?.()) url.searchParams.set('reserver', '1')
    // Outside the request: a token this director cannot mint says nothing about the cell.
    const token = await identity()
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SHADOW_SEAT_POLL_TIMEOUT_MS)
    }).catch((error: unknown) => {
      reachability.unanswered(cell.cellId, now())
      throw error
    })
    if (stopped) return false
    if (isNoBackendStatus(response.status)) reachability.unanswered(cell.cellId, now())
    else reachability.answered(cell.cellId)
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      directory.markNoFeed(cell.cellId, now(), cell.incarnation)
      return false
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      directory.fail(cell.cellId, `status_${response.status}`)
      return false
    }
    const body = SeatFeedSchema.safeParse(await response.json().catch(() => null))
    if (!body.success) {
      directory.fail(cell.cellId, 'malformed')
      return false
    }
    directory.apply(cell.cellId, body.data, now(), polledAt)
    return body.data.more === true && directory.cellState(cell.cellId)?.status === 'live'
  }

  const poll = async (cell: SeatFeedCell): Promise<void> => {
    if (inFlight.has(cell.cellId)) return
    inFlight.add(cell.cellId)
    try {
      let page = 1
      while ((await fetchPage(cell)) && page < MAX_PAGES_PER_POLL) page += 1
    } catch (error) {
      directory.fail(
        cell.cellId,
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable'
      )
    } finally {
      inFlight.delete(cell.cellId)
    }
  }

  const round = async (awaitPolls: boolean): Promise<void> => {
    if (stopped) return
    const refresh = refreshCells()
    // Await only the first cell list; later slow refreshes must not skip a poll round.
    if (cellsReadAt === undefined) await refresh
    // A slow cell holds only its own slot; the timer never waits on it.
    const polls = cells.map((cell) => poll(cell))
    if (awaitPolls) await Promise.all([refresh, ...polls])
    if (now() - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      lastSummaryAt = now()
      log(JSON.stringify({ event: 'orca_relay_shadow_seat_summary', ...directory.summary(now()) }))
    }
  }

  const timer = setInterval(() => {
    round(false).catch((error: unknown) => {
      log(
        JSON.stringify({
          event: 'orca_relay_shadow_seat_round_failed',
          reason: error instanceof Error ? error.message : 'unknown'
        })
      )
    })
  }, options.pollMs ?? SHADOW_SEAT_POLL_MS)
  timer.unref()
  return {
    directory,
    cells: () => cells,
    startedAt,
    tick: () => round(true),
    deadCellVerdict: (cellId, at) => {
      // Count peers with feed evidence, plus the candidate: PostgreSQL reserve implies a feed image, even if director restarted after it died.
      const feedCells = cells.filter((cell) => {
        if ((cell.capacityRequests ?? 1) <= 0) return false
        if (cell.cellId === cellId) return true
        const state = directory.cellState(cell.cellId)
        return state?.status !== 'no-feed' && state?.lastLiveAt !== undefined
      })
      const verdict = reachability.verdict(cellId, feedCells, at)
      // A withheld verdict strands that cell's hosts until an operator fences it, so it alerts.
      if (verdict?.withheld && at - (withheldLoggedAt.get(cellId) ?? -Infinity) >= WITHHELD_LOG_INTERVAL_MS) {
        withheldLoggedAt.set(cellId, at)
        log(JSON.stringify({ event: 'orca_relay_dead_cell_verdict_withheld', cellId, ...verdict }))
      }
      return verdict
    },
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
