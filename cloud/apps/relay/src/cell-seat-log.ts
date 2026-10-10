// Seat changes on this cell, read by directors through `GET /v1/admin/cell-seats`.
// Wire contract (v1); readers must ignore unknown fields:
//   since=<incarnation>:<seq> returns `changes` after seq, or `full` when the cursor is
//   absent, from another incarnation, or older than the ring. `seq` in the reply is the
//   cursor for the next poll; `more` says a page was cut at CELL_SEAT_FEED_PAGE_MAX.
//   Apply a change only when its generation is >= the seat's: a superseded generation's
//   socket can close after its successor joined. `full` is this log's own seats under the
//   same rules, so a reader that applies every change holds exactly `counts.seats`.
//   Step 5 adds `reserve` (a booking, never a seat) and `reservedBy` on the join it admitted;
//   a full snapshot also carries `recentlyLeft`, this cell's leavers of the last 10 minutes.

export type CellSeatState = 'active' | 'drain-only'

export type CellSeatChange = {
  seq: number
  // `active` lifts a drain-only the host cleared itself (a refreshed token after it expired).
  kind: 'join' | 'leave' | 'drain-only' | 'active' | 'reserve'
  userId: string
  relayHostId: string
  epoch: number
  generation: number
  // Only on join: a rebind under a regional drain joins already drain-only.
  state?: CellSeatState
  // Only on leave.
  closeCode?: number
  // On reserve, and on the join a booking admitted: the director that booked it.
  reservedBy?: string
  at: number
}

export type CellSeat = {
  userId: string
  relayHostId: string
  epoch: number
  generation: number
  state: CellSeatState
  joinedAt: number
}

export type RecentlyLeftCellSeat = {
  userId: string
  relayHostId: string
  epoch: number
  closeCode?: number
  at: number
}

export type CellSeatPage =
  | { seq: number; changes: CellSeatChange[]; more: boolean }
  | { seq: number; full: CellSeat[]; recentlyLeft: RecentlyLeftCellSeat[] }

// What the registry hands the route: a page plus the log's own seat count.
export type CellSeatFeedPage = CellSeatPage & { seats: number }

// ~10 minutes of a full-cell drain's joins and leaves (inferred), at ~130 B each.
export const CELL_SEAT_LOG_CAPACITY = 20_000
export const CELL_SEAT_FEED_PAGE_MAX = 2_000
// How long a leaver may rejoin here at the same epoch without the database (step 5 rule 2).
export const CELL_RECENT_SEAT_MS = 10 * 60_000
const CELL_RECENT_SEAT_MAX = 20_000

export class CellSeatLog {
  private readonly ring: (CellSeatChange | undefined)[]
  private readonly seats = new Map<string, CellSeat>()
  // Insertion order is age order.
  private readonly recent = new Map<string, RecentlyLeftCellSeat>()
  private headSeq = 0

  constructor(
    private readonly capacity = CELL_SEAT_LOG_CAPACITY,
    private readonly now: () => number = Date.now
  ) {
    this.ring = new Array<CellSeatChange | undefined>(capacity)
  }

  append(change: Omit<CellSeatChange, 'seq'>): void {
    this.headSeq += 1
    this.ring[this.headSeq % this.capacity] = { seq: this.headSeq, ...change }
    this.applyToSeats(change)
  }

  seatCount(): number {
    return this.seats.size
  }

  // `sinceSeq` null means the caller has no cursor for this incarnation.
  read(sinceSeq: number | null): CellSeatPage {
    const oldestSeq = Math.max(1, this.headSeq - this.capacity + 1)
    if (sinceSeq === null || sinceSeq > this.headSeq || sinceSeq < oldestSeq - 1) {
      return {
        seq: this.headSeq,
        full: [...this.seats.values()].map((seat) => ({ ...seat })),
        recentlyLeft: this.recentlyLeft()
      }
    }
    const lastSeq = Math.min(this.headSeq, sinceSeq + CELL_SEAT_FEED_PAGE_MAX)
    const changes: CellSeatChange[] = []
    for (let seq = sinceSeq + 1; seq <= lastSeq; seq += 1) {
      changes.push(this.ring[seq % this.capacity]!)
    }
    return { seq: lastSeq, changes, more: lastSeq < this.headSeq }
  }

  seatOf(userId: string, relayHostId: string): CellSeat | undefined {
    return this.seats.get(JSON.stringify([userId, relayHostId]))
  }

  recentlyLeftOf(userId: string, relayHostId: string): RecentlyLeftCellSeat | undefined {
    const entry = this.recent.get(JSON.stringify([userId, relayHostId]))
    return entry && entry.at > this.now() - CELL_RECENT_SEAT_MS ? entry : undefined
  }

  // The newest page's worth: an older leaver the director misses only takes the database path.
  private recentlyLeft(): RecentlyLeftCellSeat[] {
    const cutoff = this.now() - CELL_RECENT_SEAT_MS
    const live = [...this.recent.values()].filter((entry) => entry.at > cutoff)
    return live.slice(-CELL_SEAT_FEED_PAGE_MAX).map((entry) => ({ ...entry }))
  }

  private applyToSeats(change: Omit<CellSeatChange, 'seq'>): void {
    // A booking is not a seat.
    if (change.kind === 'reserve') return
    const key = JSON.stringify([change.userId, change.relayHostId])
    const seat = this.seats.get(key)
    if (seat && change.generation < seat.generation) return
    if (change.kind === 'join') {
      this.recent.delete(key)
      this.seats.set(key, {
        userId: change.userId,
        relayHostId: change.relayHostId,
        epoch: change.epoch,
        generation: change.generation,
        state: change.state ?? 'active',
        joinedAt: change.at
      })
    } else if (change.kind === 'leave') {
      if (!seat) return
      this.seats.delete(key)
      this.rememberLeft(key, {
        userId: change.userId,
        relayHostId: change.relayHostId,
        epoch: seat.epoch,
        ...(change.closeCode === undefined ? {} : { closeCode: change.closeCode }),
        at: change.at
      })
    } else if (seat) {
      seat.state = change.kind === 'active' ? 'active' : 'drain-only'
    }
  }

  private rememberLeft(key: string, entry: RecentlyLeftCellSeat): void {
    this.recent.delete(key)
    this.recent.set(key, entry)
    const cutoff = entry.at - CELL_RECENT_SEAT_MS
    for (const [oldestKey, oldest] of this.recent) {
      if (this.recent.size <= CELL_RECENT_SEAT_MAX && oldest.at > cutoff) break
      this.recent.delete(oldestKey)
    }
  }
}

// Malformed cursors are a caller bug, so they are refused rather than resynced.
export function parseCellSeatCursor(
  value: string | undefined
): { incarnation: string; seq: number } | null | 'invalid' {
  if (value === undefined || value === '') return null
  const match = /^([A-Za-z0-9-]{1,64}):(\d{1,15})$/.exec(value)
  if (!match) return 'invalid'
  return { incarnation: match[1]!, seq: Number(match[2]) }
}
