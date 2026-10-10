import {
  ASSIGNMENT_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_DEFAULT_REGION,
  type RelayRegion
} from '@orca-cloud/relay-contract'
import type { RelayAssignment } from './assignment-store.js'
import { CELL_RESERVE_TTL_MS } from './cell-reserve-contract.js'
import type { CellReserveClient } from './cell-reserve-client.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import {
  mintEpoch,
  type PlacementCell,
  type ReservePlacer
} from './reserve-placement.js'
import type { SeatFeedCell, ShadowSeat, ShadowSeatDirectory } from './shadow-seat-directory.js'

// Step 5 on a director: answer a desktop from the in-memory map for cells that report
// admitMode=reserve, and fall back to today's database path for everything else. The cell
// decides every booking; this only estimates, picks and asks.

// A leaver may rejoin its cell from memory this long, as the cell's own rule 2 allows.
export const RESERVE_STICKY_RECENT_MS = 10 * 60_000
// A starting director waits this long for every live cell before it answers.
export const RESERVE_STARTUP_GATE_MS = 30_000
const SUMMARY_INTERVAL_MS = 60_000
// A leaver for these reasons was moved off its cell; it is not sent back there.
const NO_REJOIN_CLOSE_CODES: ReadonlySet<number> = new Set([
  RELAY_CLOSE_CODE.DRAINING,
  RELAY_CLOSE_CODE.WRONG_CELL
])

export type ReservePlacementMode = 'off' | 'dry-run' | 'on'

export class ReservePaceError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('reserve_cells_paced')
  }
}

type Identity = { userId: string; relayHostId: string }

export type ReservePlan =
  | { kind: 'answer'; assignment: RelayAssignment; lane: 'sticky' | 'placement' }
  | { kind: 'retry'; retryAfterSeconds: number; reason: 'map-incomplete' | 'database' | 'paced' }
  | {
      kind: 'database'
      epochFloor?: number
      placeFresh?: () => Promise<RelayAssignment | null>
    }

export class ReserveAssignment {
  private summary: PlacementSummary = emptySummary()
  private summaryAt: number

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
      const reserve = directory.admitModeOf(cell.cellId) === 'reserve'
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
    return this.input.directory.cellIds().some((cellId) => this.input.directory.admitModeOf(cellId) === 'reserve')
  }

  async plan(identity: Identity, request: { reconnect: boolean; region: RelayRegion }): Promise<ReservePlan> {
    this.flushSummary()
    if (this.input.mode === 'off') return { kind: 'database' }
    if (this.input.mode === 'dry-run') {
      return { kind: 'database', placeFresh: async () => await this.dryRun(identity, request.region) }
    }
    if (!this.hasReserveCells()) return { kind: 'database' }
    const now = this.now()
    const { directory } = this.input
    // Until every live cell has answered, only a host that may be on an unheard cell waits.
    const incomplete = !directory.isComplete() && now - this.input.startedAt < RESERVE_STARTUP_GATE_MS
    const seats = directory.seatsOf(identity.userId, identity.relayHostId)
    const left = directory
      .recentlyLeftOf(identity.userId, identity.relayHostId, now)
      .filter((entry) => now - entry.at <= RESERVE_STICKY_RECENT_MS)
      .at(-1)
    const booking = directory.bookingOf(identity.userId, identity.relayHostId)
    const known = [
      ...seats.map((seat) => seat.epoch),
      ...(left ? [left.epoch] : []),
      ...(booking ? [booking.epoch] : [])
    ]
    let row: { cellId: string; assignmentEpoch: number } | null = null
    if (known.length === 0) {
      try {
        row = await this.input.readRow(identity)
      } catch {
        // A host the map never saw, with the database down: its epoch cannot be minted safely.
        this.summary.retries.database += 1
        return { kind: 'retry', retryAfterSeconds: 2, reason: 'database' }
      }
      if (row) known.push(row.assignmentEpoch)
    }
    const epochFloor = known.length === 0 ? 0 : Math.max(...known)
    const lastCellId = seats[0]?.cellId ?? left?.cellId ?? row?.cellId
    if (incomplete) {
      if (lastCellId !== undefined && directory.cellState(lastCellId)?.status === 'pending') {
        this.summary.retries.mapIncomplete += 1
        return { kind: 'retry', retryAfterSeconds: 1, reason: 'map-incomplete' }
      }
      // Fresh placement waits for the full map; today's path places meanwhile.
      if (lastCellId === undefined) return { kind: 'database', epochFloor }
    }

    if (request.reconnect) {
      const sticky = await this.stickyFromMemory(identity, seats, left, now)
      if (sticky) {
        this.summary.sticky += 1
        return { kind: 'answer', assignment: sticky, lane: 'sticky' }
      }
    }
    const placeFresh = async (): Promise<RelayAssignment | null> =>
      await this.placeFresh(identity, request.region, epochFloor, seats)
    // Where the host was last seen decides who owns it: a database-mode cell keeps today's
    // path, sticky included; only a fresh placement may be booked on a reserve-mode cell.
    const lastOnReserve = lastCellId !== undefined && directory.admitModeOf(lastCellId) === 'reserve'
    if (!lastOnReserve && (seats.length > 0 || left !== undefined || row !== null)) {
      return { kind: 'database', epochFloor, placeFresh }
    }
    const placed = await placeFresh()
    if (placed) return { kind: 'answer', assignment: placed, lane: 'placement' }
    return { kind: 'database', epochFloor }
  }

  // The same epoch on the same cell: no booking, no database, no row lock. A cell that
  // restarted since forgot the seat, so it is asked to hold it first.
  private async stickyFromMemory(
    identity: Identity,
    seats: ShadowSeat[],
    left: { cellId: string; epoch: number; incarnation?: string; closeCode?: number } | undefined,
    now: number
  ): Promise<RelayAssignment | null> {
    // Highest epoch first, then the newest join: only the newest grant may be answered from
    // memory, so a stale seat (or a leaver at a lower epoch) is never sent back.
    const newest = Math.max(0, ...seats.map((seat) => seat.epoch), left?.epoch ?? 0)
    const candidates: Array<{
      cellId: string
      epoch: number
      incarnation?: string
      seated: boolean
      joinedAt: number
    }> = [
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
      if (!candidate.seated && !this.input.placer.hasSeat(placement)) continue
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
    seats: readonly ShadowSeat[] = []
  ): Promise<RelayAssignment | null> {
    const placements = this.placementCells()
    if (this.random() >= this.input.placer.reservePoolShare(placements, region)) return null
    const regions = region === RELAY_DEFAULT_REGION ? [region] : [region, RELAY_DEFAULT_REGION]
    for (const target of regions) {
      const result = await this.input.placer.place({
        cells: placements,
        region: target,
        epoch: mintEpoch([epochFloor]),
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
        this.summary.retries.paced += 1
        throw new ReservePaceError(result.retryAfterSeconds)
      }
      // Database cells in this region take it; a region with none spills as today.
      const hasDatabaseCells = placements.some(
        (cell) => !cell.reserve && cell.region === target && cell.general && !cell.draining
      )
      if (hasDatabaseCells) break
    }
    this.summary.database += 1
    return null
  }

  // Never changes an answer: books nothing, and returns null so today's path places.
  private async dryRun(identity: Identity, region: RelayRegion): Promise<null> {
    const placements = this.placementCells(true)
    const cell = this.input.placer.pick(placements, region, new Set())
    const target = cell && this.input.cells().find((entry) => entry.cellId === cell.cellId)
    if (!target) return null
    const startedAt = performance.now()
    void this.input.client
      .reserve(target, { ...identity, epoch: 1, ttlMs: CELL_RESERVE_TTL_MS }, true)
      .then((answer) => {
        const elapsedMs = performance.now() - startedAt
        this.summary.dryRun.outcomes[answer.outcome] = (this.summary.dryRun.outcomes[answer.outcome] ?? 0) + 1
        this.summary.dryRun.latenciesMs.push(elapsedMs)
      })
      .catch(() => undefined)
    return null
  }

  // Supersede at placement: the old seats this director's map holds on reserve cells are told
  // to go. Each cell checks the seat's epoch and join itself, so a stale map only misses.
  private supersede(identity: Identity, seats: readonly ShadowSeat[], cellId: string, epoch: number): void {
    for (const seat of seats) {
      if (seat.cellId === cellId || seat.epoch >= epoch) continue
      if (this.input.directory.admitModeOf(seat.cellId) !== 'reserve') continue
      const cell = this.input.cells().find((entry) => entry.cellId === seat.cellId)
      if (!cell) continue
      this.summary.supersedes += 1
      void this.input.client.demote(cell, {
        v: 1,
        userId: identity.userId,
        relayHostId: identity.relayHostId,
        epoch: seat.epoch,
        joinedAt: seat.joinedAt
      })
      this.input.log?.(
        JSON.stringify({
          event: 'orca_relay_reserve_supersede',
          relayHostIdDigest: relayHostLogDigest(identity.relayHostId),
          fromCellId: seat.cellId,
          toCellId: cellId
        })
      )
    }
  }

  private flushSummary(): void {
    const now = this.now()
    if (now - this.summaryAt < SUMMARY_INTERVAL_MS) return
    this.summaryAt = now
    const { latenciesMs, outcomes } = this.summary.dryRun
    latenciesMs.sort((left, right) => left - right)
    const percentile = (share: number) =>
      latenciesMs.length === 0
        ? null
        : Math.round(latenciesMs[Math.min(latenciesMs.length - 1, Math.floor(share * latenciesMs.length))]!)
    ;(this.input.log ?? ((line: string) => console.log(line)))(
      JSON.stringify({
        event: 'orca_relay_reserve_placement_summary',
        mode: this.input.mode,
        ...this.summary,
        dryRun: { outcomes, count: latenciesMs.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99) }
      })
    )
    this.summary = emptySummary()
  }
}

type PlacementSummary = {
  sticky: number
  stickyReserves: number
  placed: number
  calls: number
  database: number
  supersedes: number
  outcomes: Record<string, number>
  retries: { mapIncomplete: number; database: number; paced: number }
  dryRun: { outcomes: Record<string, number>; latenciesMs: number[] }
}

function emptySummary(): PlacementSummary {
  return {
    sticky: 0,
    stickyReserves: 0,
    placed: 0,
    calls: 0,
    database: 0,
    supersedes: 0,
    outcomes: {},
    retries: { mapIncomplete: 0, database: 0, paced: 0 },
    dryRun: { outcomes: {}, latenciesMs: [] }
  }
}
