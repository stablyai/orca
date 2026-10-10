import type { RelayRegion } from '@orca-cloud/relay-contract'
import { CELL_INTAKE_BURST, CELL_RESERVE_TTL_MS, type ReserveOutcome } from './cell-reserve-contract.js'

// The director's half of step 5: every director picks a cell from its own map and asks the
// cell to hold a seat. It only estimates; the cell decides. Pure, so the simulation drives
// exactly this code.

export const RESERVE_MAX_TRIES = 3
// A cell not polled this recently is not a candidate (unverifiable, never gone).
export const RESERVE_CELL_FRESH_MS = 3_000
// Each director assumes it owns this share of a cell's intake (5 = the configured director
// count). Fewer live directors only under-use the budget; more only cause refusals.
export const RESERVE_DIRECTOR_SHARE = 5
export const RESERVE_PACE_MIN_SECONDS = 1
export const RESERVE_PACE_MAX_SECONDS = 10

export type PlacementCell = {
  cellId: string
  region: RelayRegion
  // The cell reports admitMode=reserve as applied.
  reserve: boolean
  general: boolean
  draining: boolean
  // When this director last sent a poll that the cell answered; null if never.
  polledAt: number | null
  seats: number
  bookings: number
  // Cell-reported placement ceiling; undefined from a cell that predates step 5.
  ceiling?: number
  intakePerSec: number
  intakeTokens: number
}

export type ReserveAttempt = ReserveOutcome | { outcome: 'unreachable' } | { outcome: string }

export type PlacementResult =
  | { kind: 'placed'; cellId: string; epoch: number; calls: number }
  // No reserve cell said yes: the caller runs today's database path.
  | { kind: 'database'; calls: number }
  // Reserve cells have seats but no intake budget: 503 with this Retry-After.
  | { kind: 'pace'; retryAfterSeconds: number; calls: number }

type Estimate = { tokens: number; refilledAt: number; ownBookings: number[] }

export class ReservePlacer {
  private readonly estimates = new Map<string, Estimate>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly share = RESERVE_DIRECTOR_SHARE
  ) {}

  isCandidate(cell: PlacementCell, region: RelayRegion, now = this.now()): boolean {
    return (
      cell.reserve &&
      cell.region === region &&
      cell.general &&
      !cell.draining &&
      cell.ceiling !== undefined &&
      cell.polledAt !== null &&
      now - cell.polledAt <= RESERVE_CELL_FRESH_MS
    )
  }

  // Seats, the cell's bookings and this director's own bookings since that poll.
  load(cell: PlacementCell): number {
    return cell.seats + cell.bookings + this.ownBookingsSince(cell)
  }

  hasSeat(cell: PlacementCell): boolean {
    return cell.ceiling !== undefined && this.load(cell) < cell.ceiling
  }

  hasBudget(cell: PlacementCell, now = this.now()): boolean {
    return this.refill(cell, now).tokens >= 1
  }

  // Power of two choices over cells with an estimated seat and budget.
  pick(cells: readonly PlacementCell[], region: RelayRegion, tried: ReadonlySet<string>) {
    const now = this.now()
    const candidates = cells.filter(
      (cell) =>
        !tried.has(cell.cellId) &&
        this.isCandidate(cell, region, now) &&
        this.hasSeat(cell) &&
        this.hasBudget(cell, now)
    )
    if (candidates.length === 0) return null
    const first = candidates[Math.floor(this.random() * candidates.length)]!
    if (candidates.length === 1) return first
    let second = candidates[Math.floor(this.random() * (candidates.length - 1))]!
    if (second === first) second = candidates[candidates.length - 1]!
    const ratio = (cell: PlacementCell) => this.load(cell) / cell.ceiling!
    return ratio(second) < ratio(first) ? second : first
  }

  async place(input: {
    cells: readonly PlacementCell[]
    region: RelayRegion
    // Above every epoch this director knows for the host.
    epoch: number
    reserve: (cellId: string, epoch: number) => Promise<ReserveAttempt>
  }): Promise<PlacementResult> {
    const tried = new Set<string>()
    let epoch = input.epoch
    let calls = 0
    while (calls < RESERVE_MAX_TRIES) {
      const cell = this.pick(input.cells, input.region, tried)
      if (!cell) break
      tried.add(cell.cellId)
      const countedAt = this.countBooking(cell)
      calls += 1
      const answer = await input.reserve(cell.cellId, epoch)
      if (answer.outcome === 'ok') return { kind: 'placed', cellId: cell.cellId, epoch, calls }
      this.uncountBooking(cell, countedAt)
      if (answer.outcome === 'intake') this.drain(cell)
      if (answer.outcome === 'seated-newer' && 'epoch' in answer && typeof answer.epoch === 'number') {
        epoch = Math.max(epoch, answer.epoch + 1)
      }
    }
    return this.fallback(input.cells, input.region, calls)
  }

  // Database cells in the region come first, then pacing; a region with neither falls to the
  // database path too, which spills to another region as today.
  fallback(cells: readonly PlacementCell[], region: RelayRegion, calls: number): PlacementResult {
    const now = this.now()
    const databaseCells = cells.some(
      (cell) => !cell.reserve && cell.region === region && cell.general && !cell.draining
    )
    if (databaseCells) return { kind: 'database', calls }
    let refillMs: number | null = null
    for (const cell of cells) {
      if (!this.isCandidate(cell, region, now) || !this.hasSeat(cell)) continue
      const estimate = this.refill(cell, now)
      const rate = this.ratePerSec(cell)
      if (rate <= 0) continue
      const waitMs = (Math.max(0, 1 - estimate.tokens) / rate) * 1_000
      refillMs = refillMs === null ? waitMs : Math.min(refillMs, waitMs)
    }
    if (refillMs === null) return { kind: 'database', calls }
    const seconds = Math.ceil(refillMs / 1_000)
    return {
      kind: 'pace',
      retryAfterSeconds: Math.min(RESERVE_PACE_MAX_SECONDS, Math.max(RESERVE_PACE_MIN_SECONDS, seconds)),
      calls
    }
  }

  // Share of the region's free seats on reserve cells; 0 unless every database cell in the
  // region reports its ceiling, so this never places only on the new pool by accident.
  reservePoolShare(cells: readonly PlacementCell[], region: RelayRegion): number {
    const now = this.now()
    let reserveFree = 0
    let databaseFree = 0
    for (const cell of cells) {
      if (cell.region !== region || !cell.general || cell.draining) continue
      if (cell.reserve) {
        if (this.isCandidate(cell, region, now)) {
          reserveFree += Math.max(0, cell.ceiling! - this.load(cell))
        }
        continue
      }
      if (cell.ceiling === undefined) return 0
      databaseFree += Math.max(0, cell.ceiling - cell.seats)
    }
    const total = reserveFree + databaseFree
    return total === 0 ? 0 : reserveFree / total
  }

  private ratePerSec(cell: PlacementCell): number {
    return cell.intakePerSec / this.share
  }

  private burst(): number {
    return Math.max(1, CELL_INTAKE_BURST / this.share)
  }

  private refill(cell: PlacementCell, now: number): Estimate {
    let estimate = this.estimates.get(cell.cellId)
    if (!estimate) {
      // A restarted director starts empty and refills, so it cannot burst on top of the others.
      estimate = { tokens: 0, refilledAt: now, ownBookings: [] }
      this.estimates.set(cell.cellId, estimate)
    }
    const elapsed = Math.max(0, now - estimate.refilledAt) / 1_000
    estimate.tokens = Math.min(this.burst(), estimate.tokens + elapsed * this.ratePerSec(cell))
    estimate.refilledAt = now
    return estimate
  }

  private ownBookingsSince(cell: PlacementCell): number {
    const estimate = this.estimates.get(cell.cellId)
    if (!estimate) return 0
    const now = this.now()
    const since = cell.polledAt ?? -Infinity
    return estimate.ownBookings.filter((at) => at >= since && at > now - CELL_RESERVE_TTL_MS)
      .length
  }

  // Returns the entry it added, so a refusal removes that one and not a concurrent call's.
  private countBooking(cell: PlacementCell): number {
    const estimate = this.refill(cell, this.now())
    estimate.tokens = Math.max(0, estimate.tokens - 1)
    const at = this.now()
    estimate.ownBookings.push(at)
    if (estimate.ownBookings.length > 1_000) estimate.ownBookings.shift()
    return at
  }

  // A refusal other than `intake` spent no token on the cell.
  private uncountBooking(cell: PlacementCell, at: number): void {
    const estimate = this.refill(cell, this.now())
    // A poll may already have dropped it; then there is nothing of this call's to remove.
    const index = estimate.ownBookings.lastIndexOf(at)
    if (index >= 0) estimate.ownBookings.splice(index, 1)
    estimate.tokens = Math.min(this.burst(), estimate.tokens + 1)
  }

  private drain(cell: PlacementCell): void {
    this.refill(cell, this.now()).tokens = 0
  }
}

export function mintEpoch(knownEpochs: Iterable<number>): number {
  let highest = 0
  for (const epoch of knownEpochs) highest = Math.max(highest, epoch)
  return highest + 1
}
