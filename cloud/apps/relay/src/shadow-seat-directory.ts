import type { RelayRegion } from '@orca-cloud/relay-contract'
import { z } from 'zod'
import type { RelayConfig } from './config.js'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'

// Step 3: each director polls every cell's seat feed and keeps who is seated
// where in memory. It decides nothing; readers only compare and report.

export const SHADOW_SEAT_POLL_MS = 1_000
export const SHADOW_SEAT_POLL_TIMEOUT_MS = 2_000
export const SHADOW_SEAT_CELL_LIST_REFRESH_MS = 30_000
export const SHADOW_SEAT_RECENTLY_LEFT_TTL_MS = 24 * 60 * 60 * 1_000
export const SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS = 100_000
const RECENTLY_LEFT_PER_HOST = 4
// Google identity tokens live an hour; one per poll would be 26 metadata reads a second.
const IDENTITY_TOKEN_REUSE_MS = 10 * 60_000
const SUMMARY_INTERVAL_MS = 60_000
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
      controls: z.number().int().nonnegative()
    })
    .partial()
    .optional(),
  flagsApplied: z
    .object({ generation: z.union([z.string(), z.number()]), flags: z.record(z.unknown()) })
    .optional(),
  changes: z.array(SeatChangeSchema).optional(),
  // The cell cut the page (2,000 changes); poll again at once.
  more: z.boolean().optional(),
  full: z.array(SeatSchema).optional()
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
}

export type ShadowSeat = {
  cellId: string
  epoch: number
  generation: number
  // 'active' or 'drain-only'; a newer cell may report other states.
  state: string
  joinedAt: number
  observedAt: number
}

export type RecentlyLeftSeat = {
  cellId: string
  epoch: number
  generation: number
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
}

type CellCursor = SeatFeedCellState & { seats: Map<string, ShadowSeat> }

export type HeartbeatSnapshot = { readAt: number; expiresAt: ReadonlyMap<string, number> }

function hostKey(userId: string, relayHostId: string): string {
  return `${userId}\u0000${relayHostId}`
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

  apply(cellId: string, response: SeatFeedResponse, now: number): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    if (response.cellId !== cellId) {
      this.fail(cellId, 'cell_id_mismatch')
      return
    }
    let seq: number | null = response.seq
    if (response.full) {
      this.replaceSeats(cursor, response.full, now)
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
  }

  // An old cell (404) has no feed; its last known seats stay, marked by status.
  markNoFeed(cellId: string, now: number): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    cursor.status = 'no-feed'
    cursor.lastAnsweredAt = now
    cursor.incarnation = undefined
    cursor.seq = undefined
  }

  fail(cellId: string, reason: string): void {
    const cursor = this.cells.get(cellId)
    if (!cursor) return
    if (cursor.status !== 'pending' && cursor.status !== 'no-feed') cursor.status = 'unverifiable'
    cursor.lastFailure = reason
  }

  // Every live cell has answered (a feed or a 404) since this director started;
  // a dead, empty or isolated cell must not hold the measurement back.
  isComplete(): boolean {
    if (this.required.size === 0) return false
    for (const cellId of this.required) {
      if (this.cells.get(cellId)?.lastAnsweredAt === undefined) return false
    }
    return true
  }

  // What the database's resolve would call this cell now, from a cell-list read up to
  // 30 s old. `unknown`: its heartbeat ran out after that read, and the next read decides.
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
          observedAt: now
        })
      } else if (change.kind === 'leave') {
        if (seat) {
          this.unseat(cursor, key)
          this.rememberLeft(key, {
            cellId: cursor.cellId,
            epoch: change.epoch,
            generation: change.generation,
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

  private replaceSeats(cursor: CellCursor, full: SeatFeedResponse['full'] & object, now: number) {
    const next = new Map<string, ShadowSeat>()
    for (const seat of full) {
      next.set(hostKey(seat.userId, seat.relayHostId), {
        cellId: cursor.cellId,
        epoch: seat.epoch,
        generation: seat.generation,
        state: seat.state,
        joinedAt: seat.joinedAt,
        observedAt: now
      })
    }
    for (const [key, seat] of cursor.seats) {
      if (next.has(key)) continue
      this.unseat(cursor, key)
      this.rememberLeft(key, {
        cellId: cursor.cellId,
        epoch: seat.epoch,
        generation: seat.generation,
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
}

export type ShadowSeatPoller = {
  directory: ShadowSeatDirectory
  // One round: refreshes the cell list when due, then polls every idle cell.
  tick: () => Promise<void>
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
  const inFlight = new Set<string>()
  let cells: SeatFeedCell[] = []
  let cellsReadAt: number | undefined
  let cellListInFlight = false
  let cellListFailures = 0
  let cellListRetryAt = 0
  let token: { value: Promise<string>; at: number } | undefined
  let lastSummaryAt = now()
  let stopped = false

  const identity = (): Promise<string> => {
    const at = now()
    if (!token || at - token.at > IDENTITY_TOKEN_REUSE_MS) {
      const value = tokenProvider(audience)
      token = { value, at }
      // A failed fetch must not be reused for ten minutes.
      value.catch(() => {
        if (token?.value === value) token = undefined
      })
    }
    return token.value
  }

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
      cellsReadAt = now()
      cellListFailures = 0
    } catch (error) {
      // Keep polling the last list; the database being down is not the cells being down.
      // Back off so a stalled database is not asked once a second on a 3-connection pool.
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
    const since = directory.since(cell.cellId)
    if (since !== undefined) url.searchParams.set('since', since)
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${await identity()}` },
      signal: AbortSignal.timeout(SHADOW_SEAT_POLL_TIMEOUT_MS)
    })
    if (stopped) return false
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      directory.markNoFeed(cell.cellId, now())
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
    directory.apply(cell.cellId, body.data, now())
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
    await refreshCells()
    // A slow cell holds only its own slot; the timer never waits on it.
    const polls = cells.map((cell) => poll(cell))
    if (awaitPolls) await Promise.all(polls)
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
    tick: () => round(true),
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
