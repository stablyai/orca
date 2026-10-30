// Unanswered director feed polls plus stale heartbeat (cell→director→Postgres) prove reserve-cell death, allowing only host-requested departure without an operator fence.

// The failing streak must span this long: the heartbeat TTL, so neither signal outruns the other.
export const CELL_POLL_DEAD_STREAK_MS = 45_000
export const CELL_POLL_DEAD_MIN_FAILURES = 3
// A gap this long (a frozen director, a stopped poller) restarts the streak: unasked is not unanswered.
export const CELL_POLL_DEAD_MAX_GAP_MS = 5_000
// Never decide from a handful of cells: one dead of three looks the same as a partition.
export const CELL_POLL_DEAD_MIN_POLLED = 6

type Streak = { startedAt: number; failures: number; lastFailedAt: number }

// Statuses that come from the load balancer, never from the cell: no backend took the request.
const NO_BACKEND_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

export function isNoBackendStatus(status: number): boolean {
  return NO_BACKEND_STATUSES.has(status)
}

// Only cells that have served this director a feed page: a legacy row that answers 404, or a cell
// never heard from, would dilute both ratios and fill the sample.
export type PolledCell = { cellId: string; region: string }

export type DeadCellVerdict = {
  dead: boolean
  // Why an unreachable cell is not called dead: too few cells to judge, or the failure is too wide
  // to be the cell (this director's network, credential, or a cross-region partition).
  withheld?: 'sample' | 'fleet' | 'region'
  fleetFailing: number
  fleetPolled: number
  regionFailing: number
  regionPolled: number
}

export class CellPollReachability {
  private readonly streaks = new Map<string, Streak>()

  // Any answer from the cell, a 401 or 404 included, proves it alive.
  answered(cellId: string): void {
    this.streaks.delete(cellId)
  }

  // A timeout, a connection failure, or a load balancer that found no backend.
  unanswered(cellId: string, now: number): void {
    const streak = this.streaks.get(cellId)
    if (!streak || now - streak.lastFailedAt > CELL_POLL_DEAD_MAX_GAP_MS) {
      this.streaks.set(cellId, { startedAt: now, failures: 1, lastFailedAt: now })
      return
    }
    streak.failures += 1
    streak.lastFailedAt = now
  }

  forget(cellIds: ReadonlySet<string>): void {
    for (const cellId of this.streaks.keys()) if (!cellIds.has(cellId)) this.streaks.delete(cellId)
  }

  // Count even young failure streaks or staggered partition starts can make the first dead verdict outrun its neighbors.
  private failing(cellId: string, now: number): boolean {
    const streak = this.streaks.get(cellId)
    return streak !== undefined && now - streak.lastFailedAt <= CELL_POLL_DEAD_MAX_GAP_MS
  }

  private unreachable(cellId: string, now: number): boolean {
    const streak = this.streaks.get(cellId)
    return (
      streak !== undefined &&
      streak.failures >= CELL_POLL_DEAD_MIN_FAILURES &&
      now - streak.lastFailedAt <= CELL_POLL_DEAD_MAX_GAP_MS &&
      streak.lastFailedAt - streak.startedAt >= CELL_POLL_DEAD_STREAK_MS
    )
  }

  // Regional directors share cross-region partitions; half a region failing cannot prove individual cell death.
  verdict(cellId: string, polled: readonly PolledCell[], now: number): DeadCellVerdict | null {
    if (!this.unreachable(cellId, now)) return null
    const region = polled.find((cell) => cell.cellId === cellId)?.region
    let fleetFailing = 0
    let regionFailing = 0
    let regionPolled = 0
    for (const cell of polled) {
      const down = this.failing(cell.cellId, now)
      if (down) fleetFailing += 1
      if (cell.region !== region) continue
      regionPolled += 1
      if (down) regionFailing += 1
    }
    const counts = { fleetFailing, fleetPolled: polled.length, regionFailing, regionPolled }
    const withheld =
      region === undefined || polled.length < CELL_POLL_DEAD_MIN_POLLED
        ? 'sample'
        : fleetFailing * 3 > polled.length
          ? 'fleet'
          : regionFailing * 2 >= regionPolled
            ? 'region'
            : undefined
    return withheld ? { dead: false, withheld, ...counts } : { dead: true, ...counts }
  }
}
