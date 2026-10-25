import {
  ASSIGNMENT_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_DEFAULT_REGION,
  RELAY_REGIONS,
  type RelayRegion
} from '@orca-cloud/relay-contract'
import type { AssignOptions, RelayAssignment } from './assignment-store.js'
import { CELL_RESERVE_TTL_MS } from './cell-reserve-contract.js'
import type { CellReserveClient } from './cell-reserve-client.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RehomeSkip, RehomeTargetRoom, ReserveRehome } from './reserve-rehome.js'
import {
  mintEpoch,
  type PlacementCell,
  type ReservePlacer
} from './reserve-placement.js'
import type { OutrankedSeat, SeatFeedCell, ShadowSeat, ShadowSeatDirectory } from './shadow-seat-directory.js'

// Step 5 on a director: answer a desktop from the in-memory map for cells that report
// admitMode=reserve, and fall back to today's database path for everything else. The cell
// decides every booking; this only estimates, picks and asks.

// A leaver may rejoin its cell from memory this long, as the cell's own rule 2 allows.
export const RESERVE_STICKY_RECENT_MS = 10 * 60_000
// A starting director waits this long for every live cell before it answers.
export const RESERVE_STARTUP_GATE_MS = 30_000
const SUMMARY_INTERVAL_MS = 60_000
// A dry-run `full` while the map showed more free room than this share of the ceiling is `fullWithRoom`.
export const RESERVE_DRY_RUN_ROOM_BOUND = 0.01
// A leaver for these reasons was moved off its cell; it is not sent back there.
const NO_REJOIN_CLOSE_CODES: ReadonlySet<number> = new Set([
  RELAY_CLOSE_CODE.DRAINING,
  RELAY_CLOSE_CODE.WRONG_CELL
])

export type ReservePlacementMode = 'off' | 'dry-run' | 'on'

export class ReservePaceError extends Error {
  // drained: the host was re-asking off a draining cell, so the 503 is the drain's, not a fault.
  constructor(
    readonly retryAfterSeconds: number,
    readonly drained = false
  ) {
    super('reserve_cells_paced')
  }
}

type Identity = { userId: string; relayHostId: string }

function hostKey(identity: Identity): string {
  return `${identity.userId}\u0000${identity.relayHostId}`
}

export type ReservePlan =
  | { kind: 'answer'; assignment: RelayAssignment; lane: 'sticky' | 'placement' | 'rehome' }
  | {
      kind: 'retry'
      retryAfterSeconds: number
      reason: 'map-incomplete' | 'database' | 'paced' | 'paced-drained'
    }
  | ({ kind: 'database' } & Pick<AssignOptions, 'epochFloor' | 'placeFresh' | 'regionReserve' | 'reserveSpill'>)

// A host whose seat the ledger reconcile demoted mints above its row for this long, so the
// re-assign does not collide with the row again (the mirror refuses an equal epoch).
export const RESERVE_ROW_FLOOR_TTL_MS = 2 * 60 * 60_000
const RESERVE_ROW_FLOOR_MAX = 100_000
const OWN_BOOKINGS_MAX = 100_000

// The WRONG_CELL row read's bound: well under a database stall (5-7 s).
export const RESERVE_WRONG_CELL_ROW_READ_MS = 1_000

// A reserve-mode cell as this director's map holds it, for the reserve-aware cell-status route.
export type ReserveCellStatus = {
  admitMode: 'db' | 'reserve'
  feedStatus: string
  // Reported, not enforced: callers set their own freshness bound.
  polledAgeMs: number
  incarnation: string
  draining: boolean
  controls: number
  seats: number
  // Null: the cell reports no step-5 numbers (for example before its switch file applies).
  bookings: number | null
  units: number | null
  ceiling: number | null
  intakePerSec: number | null
  free: number | null
}

export type ReserveCellStatusUnavailable = 'placement-off' | 'map-incomplete' | 'no-feed' | 'incarnation-mismatch'

// Rejects after `ms`; the read itself still settles later, and its failure is swallowed.
async function withinMs<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('row_read_timeout')), ms)
  })
  read.catch(() => undefined)
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class ReserveAssignment {
  private summary: PlacementSummary = emptySummary()
  private summaryAt: number
  private readonly rowFloors = new Map<string, { epoch: number; expiresAt: number }>()
  // This director's own bookings, which the cell's feed reports only a poll or more later.
  private readonly ownBookings = new Map<string, { cellId: string; epoch: number }>()
  // Hosts already counted off each drained cell, for that cell incarnation's drain.
  private readonly drainCounted = new Map<string, { incarnation: string | undefined; hosts: Set<string> }>()

  constructor(
    private readonly input: {
      mode: ReservePlacementMode
      directory: ShadowSeatDirectory
      cells: () => readonly SeatFeedCell[]
      startedAt: number
      placer: ReservePlacer
      client: CellReserveClient
      // One primary-key read of the host's row: only for a host the map has never seen.
      readRow: (identity: Identity) => Promise<{ cellId: string; assignmentEpoch: number } | null>
      // True while the pool has waiters: the optional WRONG_CELL read is skipped, so timed-out
      // reads cannot stack up behind a stall.
      databaseBusy?: () => boolean
      // Step 1 C: rehome on reconnect; absent or at 0% it never runs.
      rehome?: ReserveRehome
      now?: () => number
      random?: () => number
      log?: (line: string) => void
    }
  ) {
    this.summaryAt = this.now()
  }

  // What this director actually does; the deploy guard reads it through runtime-status.
  get placementMode(): ReservePlacementMode {
    return this.input.mode
  }

  private now(): number {
    return (this.input.now ?? Date.now)()
  }

  private random(): number {
    return (this.input.random ?? Math.random)()
  }

  placementCells(dryRun = false): PlacementCell[] {
    const { directory } = this.input
    return this.input.cells().flatMap((cell) => {
      const state = directory.cellState(cell.cellId)
      if (!state) return []
      const reserve = directory.placementModeOf(cell.cellId) === 'reserve'
      return [
        {
          cellId: cell.cellId,
          region: cell.region,
          // A dry run asks every step-5 cell, so the shadow covers cells still in database mode.
          reserve: dryRun ? state.ceiling !== undefined : reserve,
          general: cell.general === true && state.status === 'live',
          draining: state.draining === true,
          polledAt: state.status === 'live' ? (state.polledAt ?? null) : null,
          seats: Math.max(0, (state.units ?? state.reportedSeats ?? 0) - (state.bookings ?? 0)),
          bookings: state.bookings ?? 0,
          ...(state.ceiling === undefined ? {} : { ceiling: state.ceiling }),
          intakePerSec: state.intake?.perSec ?? 0,
          intakeTokens: state.intake?.tokens ?? 0
        }
      ]
    })
  }

  private hasReserveCells(): boolean {
    return this.input.directory.cellIds().some((cellId) => this.input.directory.placementModeOf(cellId) === 'reserve')
  }

  async plan(
    identity: Identity,
    // regionCorrection: the reply carries a region window bound to the database row.
    // preferred: `region` is the host's own preference, not the default.
    request: { reconnect: boolean; region: RelayRegion; regionCorrection?: boolean; preferred?: boolean }
  ): Promise<ReservePlan> {
    this.flushSummary()
    if (this.input.mode === 'off') return { kind: 'database' }
    if (this.input.mode === 'dry-run') {
      if (request.regionCorrection) return { kind: 'database' }
      return { kind: 'database', placeFresh: async () => await this.dryRun(identity, request.region) }
    }
    if (!this.hasReserveCells()) return { kind: 'database' }
    const now = this.now()
    const { directory } = this.input
    // Until every live cell has answered, only a host that may be on an unheard cell waits.
    const incomplete = this.mapIncomplete(now)
    const seats = directory.seatsOf(identity.userId, identity.relayHostId)
    const left = directory
      .recentlyLeftOf(identity.userId, identity.relayHostId, now)
      .filter((entry) => now - entry.at <= RESERVE_STICKY_RECENT_MS)
      .at(-1)
    const booking = directory.bookingOf(identity.userId, identity.relayHostId)
    const rowFloor = this.rowFloor(identity, now)
    const drainedFrom = this.drainSource(identity, seats, left, booking)
    const known = [
      ...seats.map((seat) => seat.epoch),
      ...(left ? [left.epoch] : []),
      ...(booking ? [booking.epoch] : []),
      ...(rowFloor === undefined ? [] : [rowFloor])
    ]
    let row: { cellId: string; assignmentEpoch: number } | null = null
    // A seat closed with WRONG_CELL was demoted (or failed to re-register) because its row is
    // ahead, which every director sees in that cell's feed: read the row, so the re-assign mints
    // above it on any director, not just the one that demoted it.
    const leftWrongCell =
      left?.closeCode === RELAY_CLOSE_CODE.WRONG_CELL && !(this.input.databaseBusy?.() ?? false)
    if ((known.length === 0 && !request.regionCorrection) || leftWrongCell) {
      try {
        // Only the never-seen host needs the row; for the WRONG_CELL one it is an optimisation,
        // bounded so a database stall cannot hold the reconnect (the reconcile repairs a miss).
        row =
          known.length === 0
            ? await this.input.readRow(identity)
            : await withinMs(this.input.readRow(identity), RESERVE_WRONG_CELL_ROW_READ_MS)
      } catch {
        // A host the map never saw, with the database down: its epoch cannot be minted safely.
        // One the map knows places as it did before this read existed.
        if (known.length === 0) {
          this.summary.retries.database += 1
          return { kind: 'retry', retryAfterSeconds: 2, reason: 'database' }
        }
      }
      if (row) known.push(row.assignmentEpoch)
    }
    const epochFloor = known.length === 0 ? 0 : Math.max(...known)
    const lastCellId = seats[0]?.cellId ?? left?.cellId ?? row?.cellId
    if (request.reconnect && request.preferred && !incomplete && known.length > 0) {
      const rehomed = await this.rehome(identity, request.region, seats, left, epochFloor, rowFloor ?? 0, now)
      if (rehomed) {
        return { kind: 'answer', assignment: rehomed, lane: 'rehome' }
      }
    }
    // The database lane answers it, so the window exchange follows: no memory answer, no share
    // draw, only the in-region fallback, once the map is complete and knows the host.
    if (request.regionCorrection) {
      if (incomplete) {
        return { kind: 'database' }
      }
      // A never-seen host's spill mints above the row the database lane read.
      const reserveSpill = this.reserveSpill(identity, request.region, epochFloor, seats, drainedFrom)
      return known.length === 0
        ? { kind: 'database', reserveSpill }
        : {
            kind: 'database',
            regionReserve: this.regionReserve(identity, request.region, epochFloor, seats, now, drainedFrom),
            reserveSpill
          }
    }
    if (incomplete) {
      if (lastCellId !== undefined && directory.cellState(lastCellId)?.status === 'pending') {
        this.summary.retries.mapIncomplete += 1
        return { kind: 'retry', retryAfterSeconds: 1, reason: 'map-incomplete' }
      }
      // Fresh placement waits for the full map; today's path places meanwhile.
      if (lastCellId === undefined) return { kind: 'database', epochFloor }
    }

    if (request.reconnect) {
      const sticky = await this.stickyFromMemory(identity, seats, left, now, rowFloor ?? 0)
      if (sticky) {
        this.summary.sticky += 1
        return { kind: 'answer', assignment: sticky, lane: 'sticky' }
      }
    }
    const placeFresh = async (): Promise<RelayAssignment | null> =>
      await this.placeFresh(identity, request.region, epochFloor, seats, false, false, drainedFrom)
    const regionReserve = this.regionReserve(identity, request.region, epochFloor, seats, now, drainedFrom)
    const reserveSpill = incomplete
      ? undefined
      : this.reserveSpill(identity, request.region, epochFloor, seats, drainedFrom)
    // Where the host was last seen decides who owns it: a database-mode cell keeps today's
    // path, sticky included; only a fresh placement may be booked on a reserve-mode cell.
    const lastOnReserve = lastCellId !== undefined && directory.placementModeOf(lastCellId) === 'reserve'
    if (!lastOnReserve && (seats.length > 0 || left !== undefined || row !== null)) {
      return { kind: 'database', epochFloor, placeFresh, regionReserve, reserveSpill }
    }
    const placed = await placeFresh()
    if (placed) {
      if (drainedFrom !== undefined) this.recordDrainReplaced(identity, drainedFrom, placed)
      return { kind: 'answer', assignment: placed, lane: 'placement' }
    }
    return { kind: 'database', epochFloor, regionReserve, reserveSpill }
  }

  private mapIncomplete(now: number): boolean {
    return !this.input.directory.isComplete() && now - this.input.startedAt < RESERVE_STARTUP_GATE_MS
  }

  // Keyed on the cell, not the leave: a same-cap drain (graceMs 0) has the host re-ask before
  // its leave reaches the map, but the cell's feed says draining from the first poll after.
  // Only the newest grant counts, so a host already re-booked elsewhere is not a drain re-ask.
  private drainSource(
    identity: Identity,
    seats: readonly ShadowSeat[],
    left: { cellId: string; epoch: number } | undefined,
    booking: { cellId: string; epoch: number } | undefined
  ): string | undefined {
    const own = this.ownBookings.get(hostKey(identity))
    let newest: { cellId: string; epoch: number; state?: string } | undefined
    for (const entry of [...seats, ...(left ? [left] : []), ...(booking ? [booking] : []), ...(own ? [own] : [])]) {
      if (!newest || entry.epoch > newest.epoch) newest = entry
    }
    if (!newest) return undefined
    const drained =
      newest.state === 'drain-only' || this.input.directory.cellState(newest.cellId)?.draining === true
    return drained ? newest.cellId : undefined
  }

  // Only the reserve lane's own answers: a database-lane placement off the drained (isolated)
  // cell already logs orca_relay_sticky_replaced_off_isolated_cell, and the canary sums both.
  // Each host counts once per drain: the canary bar must never pass on a host counted twice.
  private recordDrainReplaced(identity: Identity, fromCellId: string, placed: RelayAssignment): void {
    const incarnation = this.input.directory.cellState(fromCellId)?.incarnation
    let counted = this.drainCounted.get(fromCellId)
    if (!counted || counted.incarnation !== incarnation) {
      counted = { incarnation, hosts: new Set() }
      this.drainCounted.set(fromCellId, counted)
    }
    const key = hostKey(identity)
    if (counted.hosts.has(key)) return
    counted.hosts.add(key)
    this.summary.drainReplaced[fromCellId] = (this.summary.drainReplaced[fromCellId] ?? 0) + 1
    this.log(
      JSON.stringify({
        event: 'orca_relay_reserve_drain_replaced',
        fromCellId,
        toCellId: placed.cellId,
        region: placed.region
      })
    )
  }

  // The reserve-aware cell-status view, or why this director cannot vouch for the cell now.
  cellStatus(
    cellId: string,
    runtimeIncarnation: string | undefined
  ): { ok: true; reserve: ReserveCellStatus } | { ok: false; reason: ReserveCellStatusUnavailable } {
    const now = this.now()
    if (this.input.mode !== 'on') return { ok: false, reason: 'placement-off' }
    if (this.mapIncomplete(now)) return { ok: false, reason: 'map-incomplete' }
    const { directory } = this.input
    const state = directory.cellState(cellId)
    const placement = this.placementCells().find((cell) => cell.cellId === cellId)
    // An older image without these reads as no feed, never as an empty cell.
    if (
      !state ||
      !placement ||
      state.status === 'no-feed' ||
      state.incarnation === undefined ||
      state.polledAt === undefined ||
      state.draining === undefined ||
      state.reportedSeats === undefined ||
      state.reportedControls === undefined
    ) {
      return { ok: false, reason: 'no-feed' }
    }
    if (state.incarnation !== runtimeIncarnation) return { ok: false, reason: 'incarnation-mismatch' }
    return {
      ok: true,
      reserve: {
        admitMode: directory.placementModeOf(cellId),
        feedStatus: state.status,
        polledAgeMs: now - state.polledAt,
        incarnation: state.incarnation,
        draining: state.draining,
        controls: state.reportedControls,
        seats: state.reportedSeats,
        bookings: state.bookings ?? null,
        units: state.units ?? null,
        ceiling: state.ceiling ?? null,
        intakePerSec: state.intake?.perSec ?? null,
        free: state.ceiling === undefined ? null : this.input.placer.free(placement)
      }
    }
  }

  // For the share draw's losers: the database lane tries the region first, then this, then spills.
  // Undefined while no in-region reserve cell has a seat, so the database lane runs as today.
  private regionReserve(
    identity: Identity,
    region: RelayRegion,
    epochFloor: number,
    seats: readonly ShadowSeat[],
    now: number,
    drainedFrom: string | undefined
  ): AssignOptions['regionReserve'] {
    const hasRoom = this.placementCells().some(
      (cell) => this.input.placer.isCandidate(cell, region, now) && this.input.placer.hasSeat(cell)
    )
    if (!hasRoom) return undefined
    return async () => {
      const placed = await this.placeFresh(identity, region, epochFloor, seats, true, false, drainedFrom)
      if (placed) this.summary.regionKept += 1
      return placed
    }
  }

  // For a database lane that found no cell with room anywhere: each region with a reserve seat,
  // the host's own first, without the share draw. A pace is the answer only if no region places.
  private reserveSpill(
    identity: Identity,
    region: RelayRegion,
    epochFloor: number,
    seats: readonly ShadowSeat[],
    drainedFrom: string | undefined
  ): NonNullable<AssignOptions['reserveSpill']> {
    return async ({ skipOwnRegion, rowEpoch }) => {
      const floor = Math.max(epochFloor, rowEpoch)
      const now = this.now()
      let paced: ReservePaceError | undefined
      for (const target of [region, ...RELAY_REGIONS.filter((other) => other !== region)]) {
        const hasRoom =
          !(skipOwnRegion && target === region) &&
          this.placementCells().some(
            (cell) => this.input.placer.isCandidate(cell, target, now) && this.input.placer.hasSeat(cell)
          )
        if (!hasRoom) {
          continue
        }
        try {
          const placed = await this.placeFresh(identity, target, floor, seats, true, true, drainedFrom)
          if (placed) {
            this.recordSpill(region, target)
            return placed
          }
        } catch (error) {
          if (!(error instanceof ReservePaceError)) {
            throw error
          }
          if (!paced || error.retryAfterSeconds < paced.retryAfterSeconds) {
            paced = error
          }
        }
      }
      if (paced) {
        this.summary.retries.paced += 1
        throw paced
      }
      return null
    }
  }

  private recordSpill(fromRegion: RelayRegion, toRegion: RelayRegion): void {
    this.summary.spill += 1
    const key = `${fromRegion}>${toRegion}`
    this.summary.spills[key] = (this.summary.spills[key] ?? 0) + 1
  }

  // What stickyFromMemory may answer, in its order: only the newest grant (highest epoch, then
  // the newest join), on a cell that is a candidate in its own region. Lazy, so each cell is
  // judged after the previous candidate's sticky reserve settled.
  private *stickyCandidates(
    seats: readonly ShadowSeat[],
    left: { cellId: string; epoch: number; incarnation?: string; closeCode?: number } | undefined,
    now: number,
    rowFloor: number
  ) {
    const newest = Math.max(0, ...seats.map((seat) => seat.epoch), left?.epoch ?? 0)
    // A seat at or behind a row the reconcile demoted it for is never answered again.
    if (newest <= rowFloor) {
      return
    }
    const candidates: {
      cellId: string
      epoch: number
      incarnation?: string
      seated: boolean
      joinedAt: number
    }[] = [
      ...seats
        .filter((seat) => seat.state === 'active')
        .map((seat) => ({
          cellId: seat.cellId,
          epoch: seat.epoch,
          incarnation: seat.incarnation,
          seated: true,
          joinedAt: seat.joinedAt
        })),
      ...(left && !NO_REJOIN_CLOSE_CODES.has(left.closeCode ?? 0) ? [{ ...left, seated: false, joinedAt: -1 }] : [])
    ]
      .filter((candidate) => candidate.epoch === newest)
      .sort((first, second) => second.joinedAt - first.joinedAt)
    for (const candidate of candidates) {
      const cell = this.input.cells().find((entry) => entry.cellId === candidate.cellId)
      const state = this.input.directory.cellState(candidate.cellId)
      const placement = this.placementCells().find((entry) => entry.cellId === candidate.cellId)
      if (!cell || !state || !placement || !this.input.placer.isCandidate(placement, cell.region, now)) {
        continue
      }
      if (!candidate.seated && !this.input.placer.hasSeat(placement)) {
        continue
      }
      yield { candidate, cell, state, placement }
    }
  }

  // Rule set in reserve-rehome.ts; this finds the source and the target room, and books.
  private async rehome(
    identity: Identity,
    region: RelayRegion,
    seats: readonly ShadowSeat[],
    left: { cellId: string; epoch: number; incarnation?: string; closeCode?: number } | undefined,
    epochFloor: number,
    rowFloor: number,
    now: number
  ): Promise<RelayAssignment | null> {
    const rehome = this.input.rehome
    if (!rehome?.enabled) {
      return null
    }
    const source = this.stickyCandidates(seats, left, now, rowFloor).next().value
    if (!source?.placement.reserve || source.cell.region === region) {
      return null
    }
    const regionOf = (cellId: string) => this.input.cells().find((entry) => entry.cellId === cellId)?.region
    const skip = rehome.admit({
      identity,
      sourceCellId: source.cell.cellId,
      sourceControls: source.state.reportedControls ?? 0,
      leaves: this.input.directory
        .recentlyLeftOf(identity.userId, identity.relayHostId, now)
        .map((leave) => ({ region: regionOf(leave.cellId), closeCode: leave.closeCode, at: leave.at })),
      target: this.targetRoom(region, now),
      now
    })
    const record = this.rehomeRecord(source.cell.region, region)
    if (skip) {
      record.skippedByRule[skip] = (record.skippedByRule[skip] ?? 0) + 1
      return null
    }
    let placed: RelayAssignment | null = null
    try {
      placed = await this.placeFresh(identity, region, epochFloor, seats, true, true)
    } catch (error) {
      if (!(error instanceof ReservePaceError)) {
        throw error
      }
    }
    if (!placed) {
      rehome.refund(source.cell.cellId)
      record.skippedByRule['not-placed'] = (record.skippedByRule['not-placed'] ?? 0) + 1
      return null
    }
    rehome.recordMoved(identity, now)
    record.count += 1
    return placed
  }

  private targetRoom(region: RelayRegion, now: number): RehomeTargetRoom {
    const { placer } = this.input
    const candidates = this.placementCells().filter((cell) => placer.isCandidate(cell, region, now))
    return {
      free: candidates.reduce((sum, cell) => sum + placer.free(cell), 0),
      ceiling: candidates.reduce((sum, cell) => sum + (cell.ceiling ?? 0), 0),
      bookable: candidates.some((cell) => placer.hasSeat(cell) && placer.hasBudget(cell, now))
    }
  }

  private rehomeRecord(fromRegion: RelayRegion, toRegion: RelayRegion): RehomeRecord {
    const key = `${fromRegion}>${toRegion}`
    const record = this.summary.rehomes[key] ?? { count: 0, skippedByRule: {} }
    this.summary.rehomes[key] = record
    return record
  }

  // The same epoch on the same cell: no booking, no database, no row lock. A cell that
  // restarted since forgot the seat, so it is asked to hold it first.
  private async stickyFromMemory(
    identity: Identity,
    seats: ShadowSeat[],
    left: { cellId: string; epoch: number; incarnation?: string; closeCode?: number } | undefined,
    now: number,
    rowFloor: number
  ): Promise<RelayAssignment | null> {
    for (const { candidate, cell, state } of this.stickyCandidates(seats, left, now, rowFloor)) {
      if (candidate.incarnation !== undefined && candidate.incarnation !== state.incarnation) {
        const answer = await this.input.client.reserve(cell, {
          ...identity,
          epoch: candidate.epoch,
          ttlMs: CELL_RESERVE_TTL_MS,
          sticky: true
        })
        this.summary.stickyReserves += 1
        if (answer.outcome !== 'ok') continue
      }
      return {
        ...identity,
        cellId: cell.cellId,
        cellUrl: cell.cellUrl,
        assignmentEpoch: candidate.epoch,
        leaseExpiresAt: now + ASSIGNMENT_LIMITS.activityLeaseMs,
        region: cell.region
      }
    }
    return null
  }

  private async placeFresh(
    identity: Identity,
    region: RelayRegion,
    epochFloor: number,
    seats: readonly ShadowSeat[] = [],
    // The database lane found the region full: no share draw, and no other region.
    regionFull = false,
    // The caller counts its own outcome (spill, rehome): no database lane follows it, and a pace
    // may not be the answer.
    spill = false,
    drainedFrom?: string
  ): Promise<RelayAssignment | null> {
    const placements = this.placementCells()
    if (!regionFull && this.random() >= this.input.placer.reservePoolShare(placements, region)) return null
    const regions = regionFull || region === RELAY_DEFAULT_REGION ? [region] : [region, RELAY_DEFAULT_REGION]
    for (const target of regions) {
      const result = await this.input.placer.place({
        cells: placements,
        region: target,
        epoch: mintEpoch([epochFloor]),
        regionFull,
        reserve: async (cellId, epoch) => {
          const cell = this.input.cells().find((entry) => entry.cellId === cellId)
          if (!cell) return { outcome: 'unreachable' }
          const answer = await this.input.client.reserve(cell, {
            ...identity,
            epoch,
            ttlMs: CELL_RESERVE_TTL_MS
          })
          this.summary.outcomes[answer.outcome] = (this.summary.outcomes[answer.outcome] ?? 0) + 1
          return answer
        }
      })
      this.summary.calls += result.calls
      if (result.kind === 'placed') {
        this.summary.placed += 1
        this.rememberOwnBooking(identity, result.cellId, result.epoch)
        this.supersede(identity, seats, result.cellId, result.epoch)
        const cell = this.input.cells().find((entry) => entry.cellId === result.cellId)!
        return {
          ...identity,
          cellId: cell.cellId,
          cellUrl: cell.cellUrl,
          assignmentEpoch: result.epoch,
          leaseExpiresAt: this.now() + ASSIGNMENT_LIMITS.activityLeaseMs,
          region: cell.region
        }
      }
      if (result.kind === 'pace') {
        if (!spill) {
          this.summary.retries.paced += 1
        }
        throw new ReservePaceError(result.retryAfterSeconds, drainedFrom !== undefined)
      }
      // Database cells in this region take it; a region with none spills as today.
      const hasDatabaseCells = placements.some(
        (cell) => !cell.reserve && cell.region === target && cell.general && !cell.draining
      )
      if (hasDatabaseCells) break
    }
    if (!spill) {
      this.summary.database += 1
    }
    return null
  }

  // Never changes an answer: books nothing, and returns null so today's path places.
  private async dryRun(identity: Identity, region: RelayRegion): Promise<null> {
    const placements = this.placementCells(true)
    const cell = this.input.placer.pick(placements, region, new Set())
    const target = cell && this.input.cells().find((entry) => entry.cellId === cell.cellId)
    if (!target) return null
    // The map's free room at pick time; pick only returns a cell with a ceiling.
    const freeShare = cell.ceiling ? this.input.placer.free(cell) / cell.ceiling : 0
    const startedAt = performance.now()
    void this.input.client
      .reserve(target, { ...identity, epoch: 1, ttlMs: CELL_RESERVE_TTL_MS }, true)
      .then((answer) => {
        const elapsedMs = performance.now() - startedAt
        const { dryRun } = this.summary
        dryRun.outcomes[answer.outcome] = (dryRun.outcomes[answer.outcome] ?? 0) + 1
        dryRun.latenciesMs.push(elapsedMs)
        const perCell = dryRun.cells[cell.cellId] ?? { outcomes: {}, fullWithRoom: 0, minFullFreeShare: null }
        dryRun.cells[cell.cellId] = perCell
        perCell.outcomes[answer.outcome] = (perCell.outcomes[answer.outcome] ?? 0) + 1
        if (answer.outcome === 'full') {
          if (freeShare > RESERVE_DRY_RUN_ROOM_BOUND) perCell.fullWithRoom += 1
          perCell.minFullFreeShare = Math.min(perCell.minFullFreeShare ?? 1, freeShare)
        }
      })
      .catch(() => undefined)
    return null
  }

  // The ledger reconcile demoted this host's seat behind (or level with) a row at `epoch`.
  raiseEpochFloor(identity: Identity, epoch: number): void {
    const key = hostKey(identity)
    const current = this.rowFloors.get(key)
    this.rowFloors.delete(key)
    this.rowFloors.set(key, {
      epoch: Math.max(epoch, current?.epoch ?? 0),
      expiresAt: this.now() + RESERVE_ROW_FLOOR_TTL_MS
    })
    if (this.rowFloors.size > RESERVE_ROW_FLOOR_MAX) {
      this.rowFloors.delete(this.rowFloors.keys().next().value!)
    }
  }

  private rememberOwnBooking(identity: Identity, cellId: string, epoch: number): void {
    const key = hostKey(identity)
    this.ownBookings.delete(key)
    this.ownBookings.set(key, { cellId, epoch })
    if (this.ownBookings.size > OWN_BOOKINGS_MAX) {
      this.ownBookings.delete(this.ownBookings.keys().next().value!)
    }
  }

  private rowFloor(identity: Identity, now: number): number | undefined {
    const key = hostKey(identity)
    const floor = this.rowFloors.get(key)
    if (!floor) return undefined
    if (floor.expiresAt > now) return floor.epoch
    this.rowFloors.delete(key)
    return undefined
  }

  // Fire-and-forget; the cell checks the seat's epoch and join itself. False: no such cell listed.
  demoteSeat(seat: DemotedSeat, via: DemoteVia): boolean {
    const cell = this.input.cells().find((entry) => entry.cellId === seat.cellId)
    if (!cell) return false
    void this.input.client
      .demote(cell, {
        v: 1,
        userId: seat.userId,
        relayHostId: seat.relayHostId,
        epoch: seat.epoch,
        joinedAt: seat.joinedAt
      })
      .then((outcome) => this.settleDemote(seat, via, outcome))
      .catch(() => console.warn('[orca-relay] reserve demote outcome not recorded'))
    return true
  }

  // The cell repairs its own feed when it refuses a seat it still lists; this only records the answer.
  private settleDemote(seat: DemotedSeat, via: DemoteVia, outcome: string | null): void {
    this.log(
      JSON.stringify({
        event: 'orca_relay_reserve_demote_outcome',
        via,
        cellId: seat.cellId,
        epoch: seat.epoch,
        relayHostIdDigest: relayHostLogDigest(seat.relayHostId),
        outcome: outcome ?? 'unreachable'
      })
    )
  }

  // Supersede at placement: the old seats this director's map holds on reserve cells are told
  // to go. Each cell checks the seat's epoch and join itself, so a stale map only misses.
  private supersede(identity: Identity, seats: readonly ShadowSeat[], cellId: string, epoch: number): void {
    for (const seat of seats) {
      if (seat.cellId === cellId || seat.epoch >= epoch) continue
      if (this.input.directory.admitModeOf(seat.cellId) !== 'reserve') continue
      this.demoteSuperseded({ ...identity, ...seat }, cellId, 'placement')
    }
  }

  // The feed's half of supersede: a seat the booking map did not hold, found once both joins
  // are in this map. Without it that seat holds its cell until the 75 s silence close.
  supersedeOutranked(seat: OutrankedSeat): void {
    this.demoteSuperseded(seat, seat.byCellId, 'feed')
  }

  private demoteSuperseded(
    seat: { userId: string; relayHostId: string; cellId: string; epoch: number; joinedAt: number },
    toCellId: string,
    via: 'placement' | 'feed'
  ): void {
    if (!this.demoteSeat(seat, via)) return
    this.summary.supersedes += 1
    this.log(
      JSON.stringify({
        event: 'orca_relay_reserve_supersede',
        relayHostIdDigest: relayHostLogDigest(seat.relayHostId),
        fromCellId: seat.cellId,
        toCellId,
        via
      })
    )
  }

  private flushSummary(): void {
    const now = this.now()
    if (now - this.summaryAt < SUMMARY_INTERVAL_MS) return
    this.summaryAt = now
    // A drain ends when the cell stops reporting it or restarts; its next drain counts afresh.
    for (const [cellId, counted] of this.drainCounted) {
      const state = this.input.directory.cellState(cellId)
      if (!state || state.draining === false || state.incarnation !== counted.incarnation) {
        this.drainCounted.delete(cellId)
      }
    }
    const { latenciesMs, outcomes, cells } = this.summary.dryRun
    latenciesMs.sort((left, right) => left - right)
    const percentile = (share: number) =>
      latenciesMs.length === 0
        ? null
        : Math.round(latenciesMs[Math.min(latenciesMs.length - 1, Math.floor(share * latenciesMs.length))]!)
    const { spills, rehomes, ...counts } = this.summary
    this.log(
      JSON.stringify({
        event: 'orca_relay_reserve_placement_summary',
        mode: this.input.mode,
        ...counts,
        dryRun: { outcomes, count: latenciesMs.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99), cells }
      })
    )
    for (const [key, count] of Object.entries(spills)) {
      const [fromRegion, toRegion] = key.split('>')
      this.log(JSON.stringify({ event: 'orca_relay_reserve_spill', fromRegion, toRegion, count }))
    }
    for (const [key, record] of Object.entries(rehomes)) {
      const [fromRegion, toRegion] = key.split('>')
      this.log(JSON.stringify({ event: 'orca_relay_reserve_rehome', fromRegion, toRegion, ...record }))
    }
    this.summary = emptySummary()
  }

  private log(line: string): void {
    ;(this.input.log ?? ((entry: string) => console.log(entry)))(line)
  }
}

type DemotedSeat = { userId: string; relayHostId: string; cellId: string; epoch: number; joinedAt: number }
type DemoteVia = 'reconcile' | 'placement' | 'feed'

type PlacementSummary = {
  sticky: number
  stickyReserves: number
  placed: number
  // Placements the database lane would have sent out of the region.
  regionKept: number
  // Reserve bookings after the database lane found no cell anywhere, and by region pair.
  spill: number
  spills: Record<string, number>
  // Rehome on reconnect, by region pair: moves, and why an eligible host was not moved.
  rehomes: Record<string, RehomeRecord>
  calls: number
  database: number
  supersedes: number
  // Reserve-lane placements of hosts re-asking off a draining cell, keyed by that cell.
  drainReplaced: Record<string, number>
  outcomes: Record<string, number>
  retries: { mapIncomplete: number; database: number; paced: number }
  dryRun: {
    outcomes: Record<string, number>
    latenciesMs: number[]
    // Keyed by the picked cell, so bounded by the fleet.
    cells: Record<string, DryRunCellSummary>
  }
}

type RehomeRecord = { count: number; skippedByRule: Partial<Record<RehomeSkip, number>> }

type DryRunCellSummary = {
  outcomes: Record<string, number>
  fullWithRoom: number
  // Lowest map free share (of the ceiling) among this cell's `full` refusals.
  minFullFreeShare: number | null
}

function emptySummary(): PlacementSummary {
  return {
    sticky: 0,
    stickyReserves: 0,
    placed: 0,
    regionKept: 0,
    spill: 0,
    spills: {},
    rehomes: {},
    calls: 0,
    database: 0,
    supersedes: 0,
    drainReplaced: Object.create(null),
    outcomes: {},
    retries: { mapIncomplete: 0, database: 0, paced: 0 },
    dryRun: { outcomes: {}, latenciesMs: [], cells: Object.create(null) }
  }
}
