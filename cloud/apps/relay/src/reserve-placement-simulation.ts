import { createHash } from 'node:crypto'
import type { RelayRegion } from '@orca-cloud/relay-contract'
import { CellReserveBook } from './cell-reserve-book.js'
import { CELL_INTAKE_BURST, CELL_RESERVE_TTL_MS, type ReserveOutcome } from './cell-reserve-contract.js'
import {
  mintEpoch,
  RESERVE_CELL_FRESH_MS,
  RESERVE_MAX_TRIES,
  ReservePlacer,
  type PlacementCell
} from './reserve-placement.js'

// A seeded discrete-event model of step 5 that drives the real CellReserveBook and
// ReservePlacer. Everything else (sockets, the database, desktops) is modelled. The checks
// are the design's invariants 1-8; a violation is recorded, never thrown, so one run reports
// every class it hit.

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Event = { at: number; seq: number; run: () => void }

class Clock {
  now = 0
  private seq = 0
  private readonly heap: Event[] = []

  schedule(delayMs: number, run: () => void): void {
    const event = { at: this.now + Math.max(0, Math.round(delayMs)), seq: this.seq++, run }
    this.heap.push(event)
    let index = this.heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!before(this.heap[index]!, this.heap[parent]!)) break
      ;[this.heap[index], this.heap[parent]] = [this.heap[parent]!, this.heap[index]!]
      index = parent
    }
  }

  async runUntil(until: number, afterEach: () => void): Promise<void> {
    while (this.heap.length > 0 && this.heap[0]!.at <= until) {
      const event = this.pop()
      this.now = event.at
      event.run()
      // Lets the promise continuations the event released settle before the next event.
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
      afterEach()
    }
    this.now = until
  }

  private pop(): Event {
    const top = this.heap[0]!
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.heap.length && before(this.heap[left]!, this.heap[smallest]!)) smallest = left
        if (right < this.heap.length && before(this.heap[right]!, this.heap[smallest]!)) smallest = right
        if (smallest === index) break
        ;[this.heap[index], this.heap[smallest]] = [this.heap[smallest]!, this.heap[index]!]
        index = smallest
      }
    }
    return top
  }
}

function before(left: Event, right: Event): boolean {
  return left.at < right.at || (left.at === right.at && left.seq < right.seq)
}

// `leased`: admitted through the database check, so its control renews a lease there and is
// closed when the row moves on, as today.
type CellSeat = { epoch: number; joinedAt: number; reservedBy?: string; demoted: boolean; leased?: boolean }
type CellLogEntry =
  | { kind: 'join'; host: string; epoch: number; joinedAt: number; reservedBy?: string }
  | { kind: 'leave'; host: string; epoch: number; at: number; wrongCell: boolean }
  | { kind: 'reserve'; host: string; epoch: number }
  | { kind: 'demoted'; host: string; epoch: number }

const RECENT_SEAT_MS = 10 * 60_000
const DEMOTE_CLOSE_MS = 60_000
const CONTROL_RENEWAL_MS = 25_000
// As the director's: a seat this young may still be superseded.
const RECONCILE_SETTLE_MS = 30_000
// A drained seat lingers this long (its splices finishing) unless superseded first.
const DRAIN_GRACE_MS = 30_000
// A cell closes a control silent for 75 s, checked once per 25 s ping.
const CONTROL_SILENCE_CLOSE_MS = 100_000
// Longer than the slowest duplicate: a half-open seat's silence close.
const QUIESCE_MS = 150_000

export type SimulationViolation = { invariant: number; at: number; detail: string }

// Each fault breaks one rule on purpose, so a test can show the matching invariant fires.
export type SimulationFaults = {
  bookPastCap?: boolean
  intakeBurst?: number
  // Each director assumes this share of every cell's intake, instead of a fifth.
  directorShare?: number
  // Placement does not supersede the old seat: a duplicate then outlives its bound.
  skipSupersede?: boolean
  // A restarted director forgets its ledger queue and never reconciles.
  noBootReconcile?: boolean
  // The reconcile leaves a seat whose row is ahead of it alone.
  noRowAheadDemote?: boolean
  // Directors do not read the row after a WRONG_CELL leave (only the demoting one has a floor).
  noWrongCellRowRead?: boolean
  // Reserve placement re-uses the floor epoch instead of minting above it.
  mintAtFloor?: boolean
  // Today's path skips every cell Postgres records as reserve, ignoring the cell's own row.
  pgReserveBlocksDatabase?: boolean
  // Directors place by the reported mode, which stays reserve while a tripped cell re-registers.
  noRawFeedMode?: boolean
  unguardedLedger?: boolean
  noEpochFloor?: boolean
}

// relay_cell_admit_effective: each cell writes its raw mode every 15 s (cell-admit-effective-writer.ts),
// and today's path takes a reserve cell whose current-process row says db within 45 s
// (assignment-store.ts CELL_ADMIT_EFFECTIVE_FRESH_MS).
const CELL_ADMIT_EFFECTIVE_REFRESH_MS = 15_000
const CELL_ADMIT_EFFECTIVE_FRESH_MS = 45_000
// A tripped cell reports reserve until every control it admitted from memory holds a lease.
const DEFAULT_REREGISTRATION_MS = 20_000

// cell-reserve-dead-man.ts's window: 60-120 s, fixed per cell.
function deadManWindowMs(cellId: string): number {
  return 60_000 + (createHash('sha256').update(cellId).digest().readUInt32BE(0) % 60_001)
}

class SimDatabase {
  up = true
  // relay_cell_admit_modes: what the flag workflow recorded. A trip does not change it.
  readonly reserveCells = new Set<string>()
  readonly rows = new Map<string, { cellId: string; epoch: number }>()
  // relay_cell_admit_effective: written by each cell itself, never by a director.
  readonly admitEffective = new Map<string, { mode: 'db' | 'reserve'; incarnation: number; at: number }>()
  private readonly counts = new Map<string, number>()

  set(host: string, row: { cellId: string; epoch: number }): void {
    const previous = this.rows.get(host)
    if (previous) this.counts.set(previous.cellId, (this.counts.get(previous.cellId) ?? 1) - 1)
    this.counts.set(row.cellId, (this.counts.get(row.cellId) ?? 0) + 1)
    this.rows.set(host, row)
  }

  constructor(
    private readonly violate: (invariant: number, detail: string) => void,
    private readonly faults: SimulationFaults
  ) {}

  // The director's after-the-fact write, a guarded mirror: only a higher epoch replaces a row.
  upsert(host: string, cellId: string, epoch: number): void {
    const row = this.rows.get(host)
    const guarded = !this.faults.unguardedLedger
    if (guarded && row && row.epoch >= epoch) return
    if (row && epoch < row.epoch) this.violate(5, `ledger epoch fell for ${host}`)
    this.set(host, { cellId, epoch })
  }

  // Today's assign writes the row it answers with.
  assign(host: string, cellId: string, epoch: number): void {
    const row = this.rows.get(host)
    if (row && epoch <= row.epoch) this.violate(5, `db mint not above row for ${host}`)
    this.set(host, { cellId, epoch })
  }

  countOn(cellId: string): number {
    return this.counts.get(cellId) ?? 0
  }
}

class SimCell {
  readonly seats = new Map<string, CellSeat>()
  readonly recent = new Map<string, { epoch: number; at: number }>()
  readonly log: CellLogEntry[] = []
  // Per incarnation: a restarted cell starts with a full bucket.
  readonly okBookingTimes: number[][] = [[]]
  incarnation = 1
  draining = false
  mode: 'reserve' | 'db'
  bookingUnits = 0
  // What relay_cells says to a director that predates step 5: frozen at the flip.
  frozenDatabaseCount = 0
  // The dead-man (cell-reserve-dead-man.ts): a reserve cell no placing director has booked on or
  // polled with reserver=1 for its window flips itself to db, latched.
  lastContactAt = 0
  trippedAt: number | null = null
  reregisteredAt = 0
  // Booted and no flag object read yet: its mode is a default, so it writes no admit row.
  flagsUnread = false
  book: CellReserveBook

  constructor(
    readonly cellId: string,
    readonly region: RelayRegion,
    readonly hardCap: number,
    readonly ceiling: number,
    readonly intakePerSec: number,
    mode: 'reserve' | 'db',
    // An image that predates step 5 reports no ceiling and has no reserve route.
    readonly old: boolean,
    private readonly clock: Clock,
    private readonly faults: SimulationFaults,
    private readonly violate: (invariant: number, detail: string) => void
  ) {
    this.mode = mode
    this.book = this.newBook()
  }

  private newBook(): CellReserveBook {
    const limit = () => (this.faults.bookPastCap ? Infinity : this.ceiling)
    return new CellReserveBook(
      {
        canReserve: () => this.seats.size + this.bookingUnits + 1 <= limit(),
        tryReserve: () => {
          if (this.seats.size + this.bookingUnits + 1 > limit()) return null
          this.bookingUnits += 1
          let released = false
          return {
            release: () => {
              if (released) return
              released = true
              this.bookingUnits -= 1
            }
          }
        }
      },
      () => this.intakePerSec,
      () => this.clock.now,
      this.faults.intakeBurst
    )
  }

  occupancy(): number {
    return this.seats.size + this.bookingUnits
  }

  contact(): void {
    this.lastContactAt = this.clock.now
  }

  checkDeadMan(windowMs: number, reregistrationMs: number): void {
    if (this.mode !== 'reserve' || this.old || this.clock.now - this.lastContactAt <= windowMs) return
    this.mode = 'db'
    this.trippedAt = this.clock.now
    this.reregisteredAt = this.clock.now + reregistrationMs
  }

  // What the feed's admitModeEffective reports: `mode` is the raw one (switch file and dead-man).
  effectiveMode(): 'db' | 'reserve' {
    return this.mode === 'reserve' || this.clock.now < this.reregisteredAt ? 'reserve' : 'db'
  }

  reserve(directorId: string, host: string, epoch: number, sticky: boolean): ReserveOutcome {
    if (this.mode === 'reserve') this.contact()
    const outcome = this.book.reserve(
      directorId,
      { userId: host, relayHostId: 'abcdefghijklmnop', epoch, ttlMs: CELL_RESERVE_TTL_MS, sticky },
      {
        mode: this.mode,
        draining: this.draining,
        seatedEpoch: (userId) => this.seats.get(userId)?.epoch
      }
    )
    if (outcome.outcome === 'ok') {
      this.log.push({ kind: 'reserve', host, epoch })
      if (!sticky) this.okBookingTimes.at(-1)!.push(this.clock.now)
    }
    return outcome
  }

  hello(host: string, epoch: number, database: SimDatabase): boolean {
    if (this.draining) return false
    if (this.mode === 'reserve') {
      const booking = this.book.take(host, 'abcdefghijklmnop', epoch)
      if (booking) return this.seat(host, epoch, booking.directorId)
      const seated = this.seats.get(host)
      const recent = this.recent.get(host)
      if (
        (seated && seated.epoch === epoch && !seated.demoted) ||
        (recent && recent.epoch === epoch && this.clock.now - recent.at <= RECENT_SEAT_MS)
      ) {
        return this.seat(host, epoch)
      }
    }
    if (!database.up) return false
    const row = database.rows.get(host)
    if (!row || row.cellId !== this.cellId || row.epoch !== epoch) return false
    return this.seat(host, epoch, undefined, true)
  }

  private seat(host: string, epoch: number, reservedBy?: string, leased = false): boolean {
    // A rebind keeps its unit; a new seat needs one under the hard cap.
    if (!this.seats.has(host) && this.occupancy() + 1 > this.hardCap) return false
    this.seats.set(host, { epoch, joinedAt: this.clock.now, reservedBy, demoted: false, leased })
    this.recent.delete(host)
    this.log.push({ kind: 'join', host, epoch, joinedAt: this.clock.now, reservedBy })
    return true
  }

  leave(host: string): void {
    const seat = this.seats.get(host)
    if (!seat) return
    this.seats.delete(host)
    if (!seat.demoted) this.recent.set(host, { epoch: seat.epoch, at: this.clock.now })
    this.log.push({ kind: 'leave', host, epoch: seat.epoch, at: this.clock.now, wrongCell: seat.demoted })
  }

  // The cell's own check: only the seat named by epoch and join, and only in reserve mode.
  demote(host: string, epoch: number, joinedAt: number, onClose: () => void): void {
    if (this.mode !== 'reserve') return
    const seat = this.seats.get(host)
    if (!seat || seat.epoch !== epoch || seat.joinedAt !== joinedAt || seat.demoted) return
    seat.demoted = true
    this.log.push({ kind: 'demoted', host, epoch })
    this.clock.schedule(DEMOTE_CLOSE_MS, () => {
      if (this.seats.get(host) === seat) {
        this.leave(host)
        onClose()
      }
    })
  }

  // Seats, bookings and memory are gone; the image boots in database mode until its first flag read.
  restart(): string[] {
    const hosts = [...this.seats.keys()]
    for (const host of hosts) this.leave(host)
    this.book.clear()
    this.book = this.newBook()
    this.recent.clear()
    this.incarnation += 1
    this.okBookingTimes.push([])
    const mode = this.mode
    this.mode = 'db'
    this.flagsUnread = true
    this.clock.schedule(5_000, () => {
      this.mode = mode
      this.flagsUnread = false
    })
    return hosts
  }
}

type MapSeat = { epoch: number; joinedAt: number; reservedBy?: string; demoted: boolean }

type DirectorCellView = {
  incarnation: number | null
  cursor: number
  seats: Map<string, MapSeat>
  placement: PlacementCell
}

type Answer =
  | { kind: 'cell'; cellId: string; epoch: number; calls: number }
  | { kind: 'retry'; afterMs: number; calls: number }

export type SimulationConfig = {
  seed: number
  durationMs: number
  directors: number
  oldDirectors?: number
  cells: Array<{
    cellId: string
    region: RelayRegion
    hardCap: number
    ceiling: number
    intakePerSec: number
    mode: 'reserve' | 'db'
    old?: boolean
    preseated?: number
  }>
  hosts: number
  hostRegion: (index: number) => RelayRegion
  // Fresh connects arrive at this rate per second until every host has connected once.
  arrivalPerSec: number
  meanSessionMs: number
  reconnectDelayMs: [number, number]
  duplicateAssignShare: number
  // Share of departures whose old control stays half-open on the cell while the desktop
  // connects elsewhere: the real source of a host seated on two cells.
  halfOpenShare: number
  pollLagMs: (director: number) => number
  rttMs: (region: RelayRegion) => number
  faults?: SimulationFaults
  cellRestarts?: Array<{ at: number; cellId: string }>
  // Cold start budget: a restarted director's estimates start empty and refill at its share of
  // each cell's intake, so it books nothing on a cell for 1 / (intakePerSec / directors) s and
  // paces the rest (Retry-After >= 1 s); the startup gate holds unheard hosts up to 30 s.
  directorRestarts?: Array<{ at: number; director: number }>
  databaseStalls?: Array<{ at: number; durationMs: number }>
  // Every director misses every feed poll for this long (a director-side outage).
  pollOutages?: Array<{ at: number; durationMs: number }>
  // How long a tripped cell keeps reporting reserve while it leases its memory-admitted controls.
  reregistrationMs?: number
  drains?: Array<{ at: number; cellId: string; paceMs: number }>
}

export type SimulationReport = {
  violations: SimulationViolation[]
  requests: number
  placements: number
  reserveCalls: number
  exhausted: number
  paced: number
  databasePlacements: number
  reservePlacements: number
  // Rows that named a placement the desktop never used, rewritten to its real seat.
  supersedes: number
  directorRestarts: number
  rowAheadDemotions: number
  // Row-ahead demotions per demoted host: a repair that converges needs one.
  rowAheadDemotionsPerHost: { max: number; p99: number }
  deadManTrips: number
  // Bookings sent to a cell after its dead-man tripped (the cell answers `off`).
  reserveCallsOnTrippedCells: number
  databasePlacementsWhilePollsFail: number
  // From the first poll outage's start to the first fresh database placement inside it.
  pollFailureGapMs: number | null
  // First seats after a row-ahead demotion that land behind (or level with) the row again.
  badFirstReseats: number
  intakeRefusals: number
  stickyReserves: number
  stickyAnswers: number
  seatedAtEnd: number
  maxOccupancyShare: Record<string, number>
  arrivalsByCell: Record<string, number>
}

class SimDirector {
  placer!: ReservePlacer
  views = new Map<string, DirectorCellView>()
  recentlyLeft = new Map<
    string,
    { cellId: string; epoch: number; at: number; incarnation: number; wrongCell?: boolean }
  >()
  reserveEpochs = new Map<string, number>()
  // Row epochs this director demoted a host's seat behind: its next mint for the host clears them.
  rowFloors = new Map<string, number>()
  ledgerQueue: Array<{ host: string; cellId: string; epoch: number }> = []
  answeredCells = new Set<string>()
  // Set by a restart: the lost ledger queue is rebuilt by one reconcile once the map is complete.
  bootReconcilePending = false
  restarted = false
  readonly id: string

  constructor(
    readonly index: number,
    readonly old: boolean,
    private readonly random: () => number,
    private readonly clock: Clock,
    private readonly share?: number
  ) {
    this.id = `d${index}`
    this.reset()
  }

  reset(): void {
    this.placer = new ReservePlacer(() => this.clock.now, this.random, this.share)
    this.views = new Map()
    this.recentlyLeft = new Map()
    this.reserveEpochs = new Map()
    this.rowFloors = new Map()
    this.answeredCells = new Set()
    this.ledgerQueue = []
  }

  complete(cells: readonly SimCell[]): boolean {
    return cells.every((cell) => this.answeredCells.has(cell.cellId))
  }

  knownEpochs(host: string): number[] {
    const epochs: number[] = []
    for (const view of this.views.values()) {
      const seat = view.seats.get(host)
      if (seat) epochs.push(seat.epoch)
    }
    const reserved = this.reserveEpochs.get(host)
    if (reserved !== undefined) epochs.push(reserved)
    const left = this.recentlyLeft.get(host)
    if (left) epochs.push(left.epoch)
    return epochs
  }
}

export async function runReservePlacementSimulation(
  config: SimulationConfig
): Promise<SimulationReport> {
  const random = seededRandom(config.seed)
  const clock = new Clock()
  const violations: SimulationViolation[] = []
  const violate = (invariant: number, detail: string): void => {
    if (violations.length < 50) violations.push({ invariant, at: clock.now, detail })
  }
  const faults = config.faults ?? {}
  const database = new SimDatabase(violate, faults)
  const cells = config.cells.map(
    (spec) =>
      new SimCell(
        spec.cellId,
        spec.region,
        spec.hardCap,
        spec.ceiling,
        spec.intakePerSec,
        spec.mode,
        spec.old ?? false,
        clock,
        faults,
        violate
      )
  )
  const cellById = new Map(cells.map((cell) => [cell.cellId, cell]))
  for (const cell of cells) if (cell.mode === 'reserve' && !cell.old) database.reserveCells.add(cell.cellId)
  const inPollOutage = (at: number): boolean =>
    (config.pollOutages ?? []).some((outage) => at >= outage.at && at < outage.at + outage.durationMs)
  const directors = Array.from(
    { length: config.directors },
    (_, index) =>
      new SimDirector(
        index,
        index < (config.oldDirectors ?? 0),
        random,
        clock,
        config.faults?.directorShare
      )
  )
  const report: SimulationReport = {
    violations,
    requests: 0,
    placements: 0,
    reserveCalls: 0,
    exhausted: 0,
    paced: 0,
    databasePlacements: 0,
    reservePlacements: 0,
    supersedes: 0,
    directorRestarts: 0,
    rowAheadDemotions: 0,
    rowAheadDemotionsPerHost: { max: 0, p99: 0 },
    deadManTrips: 0,
    reserveCallsOnTrippedCells: 0,
    databasePlacementsWhilePollsFail: 0,
    pollFailureGapMs: null,
    badFirstReseats: 0,
    intakeRefusals: 0,
    stickyReserves: 0,
    stickyAnswers: 0,
    seatedAtEnd: 0,
    maxOccupancyShare: {},
    arrivalsByCell: {}
  }
  const between = ([low, high]: [number, number]) => low + random() * (high - low)

  // Desktops: the cell and epoch each one currently uses.
  type Host = { id: string; region: RelayRegion; current: { cellId: string; epoch: number } | null }
  const hosts: Host[] = Array.from({ length: config.hosts }, (_, index) => ({
    id: `h${index}`,
    region: config.hostRegion(index),
    current: null
  }))
  const hostById = new Map(hosts.map((host) => [host.id, host]))

  // Pre-seated hosts arrive with database rows, as hosts on a cell before its flip.
  let nextHost = 0
  for (const cell of cells) {
    const spec = config.cells.find((entry) => entry.cellId === cell.cellId)!
    for (let index = 0; index < (spec.preseated ?? 0) && nextHost < hosts.length; index += 1) {
      const host = hosts[nextHost++]!
      database.set(host.id, { cellId: cell.cellId, epoch: 1 })
      cell.seats.set(host.id, { epoch: 1, joinedAt: 0, demoted: false })
      cell.log.push({ kind: 'join', host: host.id, epoch: 1, joinedAt: 0 })
      host.current = { cellId: cell.cellId, epoch: 1 }
      scheduleLeave(host)
    }
    cell.frozenDatabaseCount = cell.seats.size
  }

  function scheduleLeave(host: Host): void {
    if (config.meanSessionMs <= 0) return
    const sessionMs = -Math.log(1 - random()) * config.meanSessionMs
    clock.schedule(sessionMs, () => {
      const current = host.current
      if (!current || quiescing) return
      const cell = cellById.get(current.cellId)!
      if (cell.seats.get(host.id)?.epoch !== current.epoch) return
      // A half-open control: the desktop moves on, the cell still holds the seat until the
      // control's silence timeout closes it.
      if (random() >= config.halfOpenShare) cell.leave(host.id)
      else {
        const seat = cell.seats.get(host.id)
        clock.schedule(CONTROL_SILENCE_CLOSE_MS, () => {
          if (cell.seats.get(host.id) === seat) cell.leave(host.id)
        })
      }
      host.current = null
      clock.schedule(between(config.reconnectDelayMs), () => connect(host, true))
    })
  }

  // --- director polling ---
  function poll(director: SimDirector, cell: SimCell): void {
    if (inPollOutage(clock.now)) return
    // A placing director's poll carries reserver=1: it is the cell's dead-man contact.
    if (!director.old && cell.mode === 'reserve') cell.contact()
    const requestedAt = clock.now
    const view = director.views.get(cell.cellId)
    const full = !view || view.incarnation !== cell.incarnation
    const seats = full ? new Map([...cell.seats].map(([host, seat]) => [host, { ...seat }])) : null
    const changes = full ? [] : cell.log.slice(view.cursor)
    const snapshot = {
      incarnation: cell.incarnation,
      cursor: cell.log.length,
      seats: cell.seats.size,
      bookings: cell.book.count(),
      tokens: cell.book.intakeSnapshot().tokens,
      mode: faults.noRawFeedMode ? cell.effectiveMode() : cell.mode,
      draining: cell.draining
    }
    const delay = config.rttMs(cell.region) + config.pollLagMs(director.index)
    clock.schedule(delay, () => {
      let current = director.views.get(cell.cellId)
      if (full) {
        if (current) {
          for (const [host, seat] of current.seats) {
            if (!seats!.has(host)) {
              director.recentlyLeft.set(host, {
                cellId: cell.cellId,
                epoch: seat.epoch,
                at: clock.now,
                incarnation: current.incarnation ?? 0
              })
            }
          }
        }
        current = {
          incarnation: snapshot.incarnation,
          cursor: snapshot.cursor,
          seats: seats!,
          placement: placementCell(cell, snapshot, requestedAt)
        }
        director.views.set(cell.cellId, current)
      } else if (current && current.incarnation === snapshot.incarnation) {
        for (const change of changes) applyChange(director, cell, current, change)
        current.cursor = snapshot.cursor
        current.placement = placementCell(cell, snapshot, requestedAt)
      } else {
        // A restarted director's (or a stale) delta: the next poll asks for a full snapshot.
        return
      }
      director.answeredCells.add(cell.cellId)
    })
  }

  function placementCell(
    cell: SimCell,
    snapshot: { seats: number; bookings: number; tokens: number; mode: string; draining: boolean },
    polledAt: number
  ): PlacementCell {
    return {
      cellId: cell.cellId,
      region: cell.region,
      reserve: !cell.old && snapshot.mode === 'reserve',
      general: true,
      draining: snapshot.draining,
      polledAt,
      seats: snapshot.seats,
      bookings: snapshot.bookings,
      ceiling: cell.old ? undefined : cell.ceiling,
      intakePerSec: cell.intakePerSec,
      intakeTokens: snapshot.tokens
    }
  }

  function applyChange(
    director: SimDirector,
    cell: SimCell,
    view: DirectorCellView,
    change: CellLogEntry
  ): void {
    if (change.kind === 'reserve') {
      director.reserveEpochs.set(
        change.host,
        Math.max(director.reserveEpochs.get(change.host) ?? 0, change.epoch)
      )
    } else if (change.kind === 'join') {
      view.seats.set(change.host, {
        epoch: change.epoch,
        joinedAt: change.joinedAt,
        reservedBy: change.reservedBy,
        demoted: false
      })
      director.recentlyLeft.delete(change.host)
      // Exactly one director writes each booked join: the one that booked it.
      if (change.reservedBy === director.id) {
        director.ledgerQueue.push({ host: change.host, cellId: cell.cellId, epoch: change.epoch })
      }
    } else if (change.kind === 'leave') {
      const seat = view.seats.get(change.host)
      if (seat && seat.epoch === change.epoch) {
        view.seats.delete(change.host)
        director.recentlyLeft.set(change.host, {
          cellId: cell.cellId,
          epoch: change.epoch,
          at: change.at,
          incarnation: view.incarnation ?? 0,
          wrongCell: change.wrongCell
        })
      }
    } else {
      const seat = view.seats.get(change.host)
      if (seat && seat.epoch === change.epoch) seat.demoted = true
    }
  }

  // Supersede at placement: the director that books a host on `cellId` tells the old seats its
  // map holds on reserve cells to go. Each cell checks epoch and join itself.
  function supersede(director: SimDirector, host: string, cellId: string, epoch: number): void {
    if (faults.skipSupersede) return
    for (const [seatCellId, view] of director.views) {
      const seat = view.seats.get(host)
      if (!seat || seat.demoted || seatCellId === cellId || seat.epoch >= epoch) continue
      if (!view.placement.reserve) continue
      const loser = cellById.get(seatCellId)!
      report.supersedes += 1
      clock.schedule(config.rttMs(loser.region), () =>
        loser.demote(host, seat.epoch, seat.joinedAt, () => onSeatClosed(host, seatCellId, seat.epoch))
      )
    }
  }

  function onSeatClosed(hostId: string, cellId: string, epoch: number): void {
    const host = hostById.get(hostId)!
    if (host.current?.cellId === cellId && host.current.epoch === epoch) {
      host.current = null
      clock.schedule(between(config.reconnectDelayMs), () => connect(host, true))
    }
  }

  function flushLedger(director: SimDirector): void {
    if (!database.up || director.ledgerQueue.length === 0) return
    for (const entry of director.ledgerQueue) {
      database.upsert(entry.host, entry.cellId, entry.epoch)
    }
    director.ledgerQueue = []
  }

  // Invariant 8: a reserve seat behind its row (today's path wrote a newer epoch, and the
  // desktop was answered the old seat from memory), or level with it on another cell, is gone
  // by the next reconcile, and the director that demoted it re-places the host above the row.
  const behindRow = new Map<string, number>()
  const rowAheadDemotionsByHost = new Map<string, number>()
  const demotedBehindRow = new Map<string, number>()
  // A host demoted behind its row: its next answer, from any director, is that row or above it.
  const reassignAbove = new Map<string, { cellId: string; epoch: number }>()
  function reconcileLedger(director: SimDirector): void {
    if (!database.up || director.old) return
    for (const [cellId, view] of director.views) {
      if (!view.placement.reserve) continue
      for (const [host, seat] of view.seats) {
        if (seat.demoted || clock.now - seat.joinedAt < RECONCILE_SETTLE_MS) continue
        const row = database.rows.get(host)
        const live = cellById.get(cellId)!.seats.get(host)
        const diverged = row && (row.epoch > seat.epoch || (row.epoch === seat.epoch && row.cellId !== cellId))
        if (row && diverged && live && live.joinedAt === seat.joinedAt && !live.demoted) {
          const key = `${director.id}\u0000${host}\u0000${cellId}\u0000${seat.joinedAt}`
          if (behindRow.has(key)) violate(8, `${host}@${seat.epoch} on ${cellId} still behind row @${row.epoch}`)
          behindRow.set(key, clock.now)
          if (faults.noRowAheadDemote) continue
          report.rowAheadDemotions += 1
          director.rowFloors.set(host, Math.max(row.epoch, director.rowFloors.get(host) ?? 0))
          rowAheadDemotionsByHost.set(host, (rowAheadDemotionsByHost.get(host) ?? 0) + 1)
          // A director that had not seen the leave may re-place level with the row once; a later
          // divergence (a newer row) may demote the host again. One row never takes a third.
          const sameRow = `${host}\u0000${row.cellId}\u0000${row.epoch}`
          const behindThisRow = (demotedBehindRow.get(sameRow) ?? 0) + 1
          demotedBehindRow.set(sameRow, behindThisRow)
          if (behindThisRow > 2) violate(8, `${host} demoted ${behindThisRow} times behind its row ${row.cellId}@${row.epoch}`)
          reassignAbove.set(host, { ...row })
          const cell = cellById.get(cellId)!
          clock.schedule(config.rttMs(cell.region), () =>
            cell.demote(host, seat.epoch, seat.joinedAt, () => onSeatClosed(host, cellId, seat.epoch))
          )
          continue
        }
        database.upsert(host, cellId, seat.epoch)
      }
    }
  }

  // --- assignment ---
  function reserveCall(
    director: SimDirector,
    cell: SimCell,
    host: string,
    epoch: number,
    sticky: boolean
  ): Promise<ReserveOutcome | { outcome: 'unreachable' }> {
    const rtt = config.rttMs(cell.region)
    return new Promise((resolve) => {
      clock.schedule(rtt / 2, () => {
        const outcome = cell.old ? { outcome: 'off' as const } : cell.reserve(director.id, host, epoch, sticky)
        if (outcome.outcome === 'intake') report.intakeRefusals += 1
        if (outcome.outcome === 'off' && cell.trippedAt !== null) report.reserveCallsOnTrippedCells += 1
        clock.schedule(rtt / 2, () => resolve(outcome))
      })
    })
  }

  function databaseAssign(director: SimDirector, host: Host, floor: number): Answer {
    if (!database.up) return { kind: 'retry', afterMs: 2_000, calls: 0 }
    const row = database.rows.get(host.id)
    // Postgres still says reserve after a trip; the cell's own fresh row (db, current process)
    // lets today's path back in, with or without any feed poll getting through.
    const admitsDatabase = (cell: SimCell): boolean => {
      const own = database.admitEffective.get(cell.cellId)
      return (
        !faults.pgReserveBlocksDatabase &&
        own?.mode === 'db' &&
        own.incarnation === cell.incarnation &&
        clock.now - own.at <= CELL_ADMIT_EFFECTIVE_FRESH_MS
      )
    }
    const eligible = cells.filter((cell) => {
      if (cell.draining) return false
      if (!director.old && database.reserveCells.has(cell.cellId) && !admitsDatabase(cell)) return false
      const count = cell.mode === 'reserve' ? cell.frozenDatabaseCount : database.countOn(cell.cellId)
      return count < cell.ceiling
    })
    const load = (cell: SimCell) =>
      (cell.mode === 'reserve' ? cell.frozenDatabaseCount : database.countOn(cell.cellId)) / cell.ceiling
    const inRegion = eligible.filter((cell) => cell.region === host.region)
    const pool = inRegion.length > 0 ? inRegion : eligible
    if (pool.length === 0) {
      // A cell that tripped 20 s ago (a 1 s write, a 5 s cached read, slack) must be takeable.
      const stranded = cells.find(
        (cell) =>
          !director.old &&
          !cell.old &&
          !cell.draining &&
          cell.trippedAt !== null &&
          cell.mode === 'db' &&
          clock.now - cell.trippedAt >= 20_000 &&
          database.countOn(cell.cellId) < cell.ceiling
      )
      if (stranded) violate(9, `${host.id}: ${stranded.cellId} tripped but takes no fresh placement`)
      return { kind: 'retry', afterMs: 5_000, calls: 0 }
    }
    const target = pool.reduce((best, cell) => (load(cell) < load(best) ? cell : best))
    const epoch = Math.max(row?.epoch ?? 0, faults.noEpochFloor ? 0 : floor) + 1
    if (!director.old && epoch <= floor) violate(7, `db mint ${epoch} not above map floor ${floor}`)
    database.assign(host.id, target.cellId, epoch)
    if (target.mode === 'reserve') target.frozenDatabaseCount += 1
    report.databasePlacements += 1
    const outage = (config.pollOutages ?? [])[0]
    if (inPollOutage(clock.now)) {
      report.databasePlacementsWhilePollsFail += 1
      if (outage && report.pollFailureGapMs === null) report.pollFailureGapMs = clock.now - outage.at
    }
    return { kind: 'cell', cellId: target.cellId, epoch, calls: 0 }
  }

  async function assign(director: SimDirector, host: Host, reconnect: boolean): Promise<Answer> {
    report.requests += 1
    if (director.old) return databaseAssign(director, host, 0)
    if (!director.complete(cells)) return { kind: 'retry', afterMs: 1_000, calls: 0 }
    const now = clock.now
    const rowFloor = director.rowFloors.get(host.id)
    const known = [...director.knownEpochs(host.id), ...(rowFloor === undefined ? [] : [rowFloor])]
    let floor: number
    if (known.length > 0) {
      floor = Math.max(...known)
      // A WRONG_CELL leave, seen in the cell's feed by every director: read the row too.
      if (director.recentlyLeft.get(host.id)?.wrongCell && !faults.noWrongCellRowRead && database.up) {
        floor = Math.max(floor, database.rows.get(host.id)?.epoch ?? 0)
      }
    } else {
      if (!database.up) return { kind: 'retry', afterMs: 2_000, calls: 0 }
      floor = database.rows.get(host.id)?.epoch ?? 0
    }
    if (reconnect) {
      const found = stickyFromMemory(director, host, now)
      // The seat the reconcile demoted (or one level with its row) is never answered again.
      const sticky = found && rowFloor !== undefined && found.epoch <= rowFloor ? null : found
      if (sticky) {
        const cell = cellById.get(sticky.cellId)!
        // The map's own view of the cell's incarnation: a restart not yet polled answers stale,
        // and the hello then falls to the database check.
        const view = director.views.get(sticky.cellId)
        if (sticky.incarnation === view?.incarnation || cell.old) {
          report.stickyAnswers += 1
          return { kind: 'cell', cellId: sticky.cellId, epoch: sticky.epoch, calls: 0 }
        }
        report.stickyReserves += 1
        const outcome = await reserveCall(director, cell, host.id, sticky.epoch, true)
        if (outcome.outcome === 'ok') {
          report.stickyAnswers += 1
          return { kind: 'cell', cellId: sticky.cellId, epoch: sticky.epoch, calls: 1 }
        }
      }
    }
    const placements = [...director.views.values()].map((view) => view.placement)
    if (random() >= director.placer.reservePoolShare(placements, host.region)) {
      return databaseAssign(director, host, floor)
    }
    const result = await director.placer.place({
      cells: placements,
      region: host.region,
      epoch: faults.mintAtFloor ? Math.max(1, floor) : mintEpoch([floor]),
      reserve: (cellId, epoch) => reserveCall(director, cellById.get(cellId)!, host.id, epoch, false)
    })
    report.reserveCalls += result.calls
    if (result.calls > RESERVE_MAX_TRIES) violate(6, `${result.calls} reserve calls in one request`)
    if (result.kind === 'placed') {
      report.reservePlacements += 1
      supersede(director, host.id, result.cellId, result.epoch)
      return { kind: 'cell', cellId: result.cellId, epoch: result.epoch, calls: result.calls }
    }
    if (result.calls === RESERVE_MAX_TRIES) report.exhausted += 1
    if (result.kind === 'pace') {
      report.paced += 1
      return { kind: 'retry', afterMs: result.retryAfterSeconds * 1_000, calls: result.calls }
    }
    const fallback = databaseAssign(director, host, floor)
    return fallback.kind === 'cell' ? { ...fallback, calls: result.calls } : fallback
  }

  function stickyFromMemory(director: SimDirector, host: Host, now: number) {
    // The newest grant only: highest epoch, then newest join.
    const seats = [...director.views]
      .map(([cellId, view]) => ({ cellId, view, seat: view.seats.get(host.id) }))
      .filter((entry) => entry.seat && !entry.seat.demoted)
      .sort((left, right) => right.seat!.epoch - left.seat!.epoch || right.seat!.joinedAt - left.seat!.joinedAt)
    const top = seats[0]
    if (top && stickyCell(director, top.view, now, true)) {
      return { cellId: top.cellId, epoch: top.seat!.epoch, incarnation: top.view.incarnation ?? 0 }
    }
    if (top) return null
    const left = director.recentlyLeft.get(host.id)
    // A seat closed WRONG_CELL may not rejoin from memory.
    if (left && !left.wrongCell && now - left.at <= RECENT_SEAT_MS) {
      const view = director.views.get(left.cellId)
      if (view && stickyCell(director, view, now, false)) {
        return { cellId: left.cellId, epoch: left.epoch, incarnation: left.incarnation }
      }
    }
    return null
  }

  function stickyCell(director: SimDirector, view: DirectorCellView, now: number, seated: boolean): boolean {
    const cell = view.placement
    if (!cell.reserve || !cell.general || cell.draining || cell.polledAt === null) return false
    if (now - cell.polledAt > RESERVE_CELL_FRESH_MS) return false
    return seated || director.placer.hasSeat(cell)
  }

  // --- desktops ---
  let directorCursor = 0
  function pickDirector(): SimDirector {
    directorCursor = (directorCursor + 1 + Math.floor(random() * directors.length)) % directors.length
    return directors[directorCursor]!
  }

  // After the run, desktops stop moving so the maps and the ledger can settle.
  let quiescing = false
  function connect(host: Host, reconnect: boolean): void {
    if (host.current || quiescing) return
    const first = pickDirector()
    const duplicate = random() < config.duplicateAssignShare ? pickDirector() : null
    let used = false
    const onAnswer = (answer: Answer, primary: boolean): void => {
      if (answer.kind === 'retry') {
        if (primary && !used) {
          used = true
          clock.schedule(answer.afterMs + random() * 500, () => connect(host, reconnect))
        }
        return
      }
      if (used) return
      used = true
      clock.schedule(50 + random() * 250, () => hello(host, answer.cellId, answer.epoch, reconnect))
    }
    // A throw in the model is a broken run, recorded like any violated rule.
    const broken = (error: unknown) => violate(0, `model threw: ${String(error)}`)
    void assign(first, host, reconnect)
      .then((answer) => onAnswer(answer, true))
      .catch(broken)
    if (duplicate) {
      clock.schedule(random() * 500, () => {
        void assign(duplicate, host, reconnect)
          .then((answer) => onAnswer(answer, false))
          .catch(broken)
      })
    }
  }

  function hello(host: Host, cellId: string, epoch: number, reconnect: boolean): void {
    const cell = cellById.get(cellId)!
    if (host.current) return
    const admitted = cell.hello(host.id, epoch, database)
    if (!admitted) {
      clock.schedule(1_000 + random() * 2_000, () => connect(host, reconnect))
      return
    }
    report.placements += 1
    report.arrivalsByCell[cellId] = (report.arrivalsByCell[cellId] ?? 0) + 1
    // Reported, not a violation: the first seat after a demotion behind the row lands on that
    // row or above it, unless the answering director's map had not yet seen the leave.
    const above = reassignAbove.get(host.id)
    if (above !== undefined) {
      reassignAbove.delete(host.id)
      if (epoch < above.epoch || (epoch === above.epoch && cellId !== above.cellId)) report.badFirstReseats += 1
    }
    host.current = { cellId, epoch }
    scheduleLeave(host)
  }

  // --- schedule ---
  for (const cell of cells) {
    const windowMs = deadManWindowMs(cell.cellId)
    const check = (): void => {
      const wasReserve = cell.mode === 'reserve'
      cell.checkDeadMan(windowMs, config.reregistrationMs ?? DEFAULT_REREGISTRATION_MS)
      if (wasReserve && cell.mode === 'db') report.deadManTrips += 1
      // Best-effort through the cell's own pool: nothing to write while the database is down,
      // and only while its switch says reserve (a db cell never writes one).
      const own = database.admitEffective.get(cell.cellId)
      if (
        !cell.old &&
        database.reserveCells.has(cell.cellId) &&
        !cell.flagsUnread &&
        database.up &&
        (!own || own.mode !== cell.mode || own.incarnation !== cell.incarnation || clock.now - own.at >= CELL_ADMIT_EFFECTIVE_REFRESH_MS)
      ) {
        database.admitEffective.set(cell.cellId, { mode: cell.mode, incarnation: cell.incarnation, at: clock.now })
      }
      clock.schedule(1_000, check)
    }
    clock.schedule(1_000, check)
  }
  for (const director of directors) {
    const tick = (): void => {
      for (const cell of cells) poll(director, cell)
      if (director.bootReconcilePending && director.complete(cells)) {
        director.bootReconcilePending = false
        reconcileLedger(director)
      }
      clock.schedule(1_000, tick)
    }
    clock.schedule(random() * 1_000, tick)
    const ledger = (): void => {
      flushLedger(director)
      clock.schedule(250, ledger)
    }
    clock.schedule(250, ledger)
    const reconcile = (): void => {
      reconcileLedger(director)
      clock.schedule(10 * 60_000 + random() * 60_000, reconcile)
    }
    // As on a real director: once at boot when the map is complete, then every 10 minutes.
    director.bootReconcilePending = true
    clock.schedule(10 * 60_000 + random() * 60_000, reconcile)
  }
  // A leased control's renewal fails once its row names another seat: the cell closes it.
  for (const cell of cells) {
    const renew = (): void => {
      if (database.up) {
        for (const [hostId, seat] of [...cell.seats]) {
          const row = database.rows.get(hostId)
          if (!seat.leased || !row || (row.cellId === cell.cellId && row.epoch === seat.epoch)) continue
          cell.leave(hostId)
          onSeatClosed(hostId, cell.cellId, seat.epoch)
        }
      }
      clock.schedule(CONTROL_RENEWAL_MS, renew)
    }
    clock.schedule(random() * CONTROL_RENEWAL_MS, renew)
  }
  for (const cell of cells) {
    const sweep = (): void => {
      cell.book.sweep()
      clock.schedule(1_000, sweep)
    }
    clock.schedule(1_000, sweep)
  }
  const fresh = hosts.slice(nextHost)
  fresh.forEach((host, index) => {
    clock.schedule((index / config.arrivalPerSec) * 1_000, () => connect(host, false))
  })
  for (const restart of config.cellRestarts ?? []) {
    clock.schedule(restart.at, () => {
      const cell = cellById.get(restart.cellId)!
      for (const hostId of cell.restart()) {
        const host = hostById.get(hostId)!
        if (host.current?.cellId !== cell.cellId) continue
        host.current = null
        clock.schedule(random() * 10_000, () => connect(host, true))
      }
    })
  }
  for (const restart of config.directorRestarts ?? []) {
    clock.schedule(restart.at, () => {
      const director = directors[restart.director]!
      director.reset()
      director.restarted = true
      director.bootReconcilePending = !faults.noBootReconcile
      report.directorRestarts += 1
    })
  }
  for (const stall of config.databaseStalls ?? []) {
    clock.schedule(stall.at, () => {
      database.up = false
      clock.schedule(stall.durationMs, () => {
        database.up = true
      })
    })
  }
  for (const drain of config.drains ?? []) {
    clock.schedule(drain.at, () => {
      const cell = cellById.get(drain.cellId)!
      cell.draining = true
      const seated = [...cell.seats.keys()]
      seated.forEach((hostId, index) => {
        clock.schedule((index / Math.max(1, seated.length - 1)) * drain.paceMs, () => {
          const host = hostById.get(hostId)!
          const seat = cell.seats.get(hostId)
          if (!seat) return
          // Drain-only: the seat keeps its splices for the grace while the desktop moves on.
          clock.schedule(DRAIN_GRACE_MS, () => {
            if (cell.seats.get(hostId) === seat) cell.leave(hostId)
          })
          if (host.current?.cellId === cell.cellId) {
            host.current = null
            clock.schedule(1_000 + random() * 5_000, () => connect(host, true))
          }
        })
      })
    })
  }

  // --- invariants checked after every event ---
  const afterEach = (): void => {
    for (const cell of cells) {
      if (cell.occupancy() > cell.hardCap) {
        violate(1, `${cell.cellId} at ${cell.occupancy()} over hard cap ${cell.hardCap}`)
      }
      const share = cell.occupancy() / cell.hardCap
      report.maxOccupancyShare[cell.cellId] = Math.max(report.maxOccupancyShare[cell.cellId] ?? 0, share)
    }
  }
  // A booking supersedes the old seat within a round trip; a duplicate nobody books past (a
  // half-open seat while today's path places the host) lasts until that seat's silence close.
  const supersedeBound =
    Math.max(...directors.map((director) => config.pollLagMs(director.index))) +
    2 * Math.max(...cells.map((cell) => config.rttMs(cell.region))) +
    3_000
  const duplicateBound = CONTROL_SILENCE_CLOSE_MS + 2 * Math.max(...cells.map((cell) => config.rttMs(cell.region))) + 1_000
  // Invariant 3: a seat outranked by a newer one (a higher epoch elsewhere) is gone within the
  // bound. Only seats on reserve cells are step 5's: between database-mode cells today's lease
  // renewal closes the stale control, as it does now.
  const outrankedSince = new Map<string, number>()
  const checkDuplicates = (): void => {
    const seatsByHost = new Map<string, Array<{ cell: SimCell; seat: CellSeat }>>()
    for (const cell of cells) {
      for (const [host, seat] of cell.seats) {
        if (seat.demoted) continue
        const seats = seatsByHost.get(host) ?? []
        seats.push({ cell, seat })
        seatsByHost.set(host, seats)
      }
    }
    const live = new Set<string>()
    for (const [host, seats] of seatsByHost) {
      if (seats.length < 2) continue
      const newest = Math.max(...seats.map((entry) => entry.seat.epoch))
      // A seat outranked by a booking is superseded within the booking director's poll lag and
      // a round trip; anything else (today's path placed the host) waits for the silence close.
      const booked = seats.some((entry) => entry.seat.epoch === newest && entry.seat.reservedBy !== undefined)
      for (const { cell, seat } of seats) {
        if (cell.mode !== 'reserve' || seat.epoch === newest) continue
        // A leased seat goes by its renewal, as today.
        const bound = booked && !seat.leased ? supersedeBound : duplicateBound
        const key = `${host}\u0000${cell.cellId}\u0000${seat.joinedAt}`
        live.add(key)
        const since = outrankedSince.get(key) ?? clock.now
        outrankedSince.set(key, since)
        if (clock.now - since > bound) {
          violate(3, `${host}@${seat.epoch} on ${cell.cellId} outranked for ${clock.now - since} ms`)
        }
      }
    }
    for (const key of [...outrankedSince.keys()]) if (!live.has(key)) outrankedSince.delete(key)
    clock.schedule(1_000, checkDuplicates)
  }
  clock.schedule(1_000, checkDuplicates)

  await clock.runUntil(config.durationMs, afterEach)
  quiescing = true
  await clock.runUntil(config.durationMs + QUIESCE_MS, afterEach)

  // Invariant 2: no window holds more ok bookings than burst + rate x window.
  for (const cell of cells) {
    for (const times of cell.okBookingTimes) {
      let lowest = Infinity
      times.forEach((at, index) => {
        lowest = Math.min(lowest, index - (cell.intakePerSec * at) / 1_000)
        const excess = index - (cell.intakePerSec * at) / 1_000 - lowest + 1
        if (excess > CELL_INTAKE_BURST + 1e-6) {
          violate(2, `${cell.cellId} booked ${excess.toFixed(2)} over its bucket`)
        }
      })
    }
  }
  // Invariant 5: the ledger is a guarded mirror. After one reconcile with the database up, a
  // host seated once, at its highest epoch, on a reserve cell has a row at that epoch or above.
  // No final reconcile: what the queues, the boot reconcile and the 10-minute one wrote is
  // what a reader would see.
  database.up = true
  for (const director of directors) flushLedger(director)
  for (const cell of cells) {
    if (cell.mode !== 'reserve') continue
    for (const [host, seat] of cell.seats) {
      if (seat.demoted) continue
      const otherSeat = cells.some(
        (other) => other !== cell && other.seats.get(host) && !other.seats.get(host)!.demoted
      )
      if (otherSeat) continue
      const row = database.rows.get(host)
      if (!row || row.epoch < seat.epoch) {
        violate(5, `${host} row ${JSON.stringify(row)} is below its seat ${cell.cellId}@${seat.epoch}`)
      }
    }
  }
  report.seatedAtEnd = cells.reduce((sum, cell) => sum + cell.seats.size, 0)
  const perHost = [...rowAheadDemotionsByHost.values()].sort((left, right) => left - right)
  report.rowAheadDemotionsPerHost = {
    max: perHost.at(-1) ?? 0,
    p99: perHost[Math.min(perHost.length - 1, Math.floor(perHost.length * 0.99))] ?? 0
  }
  return report
}
