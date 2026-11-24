import type { CellSeat } from './cell-seat-log.js'

// How often the cell checks its seat log against its live sessions, on a director's feed poll.
export const CELL_SEAT_DRIFT_SWEEP_MS = 30_000

export type SeatBackingSession = {
  state: string
  socket: unknown
  assignmentEpoch: number
  generation: number
}

export type UnbackedSeatReason = 'no-session' | 'closed' | 'no-socket' | 'epoch' | 'generation'

// Why no live session backs this seat, or null when one does. A session backs its seat only at
// the epoch and generation it joined with; anything else is a seat the feed should not list.
export function unbackedSeatReason(
  seat: Pick<CellSeat, 'epoch' | 'generation'>,
  session: SeatBackingSession | null
): UnbackedSeatReason | null {
  if (!session) return 'no-session'
  if (session.state === 'closed') return 'closed'
  if (!session.socket) return 'no-socket'
  if (session.assignmentEpoch !== seat.epoch) return 'epoch'
  if (session.generation !== seat.generation) return 'generation'
  return null
}

// Drift found on two sweeps in a row is repaired: a drained session's seat stays listed for the
// few seconds until its socket's close lands, and that is not drift.
export class SeatDriftConfirmation {
  private seen = new Set<string>()
  private sweptAt = Number.NEGATIVE_INFINITY

  due(now: number): boolean {
    if (now - this.sweptAt < CELL_SEAT_DRIFT_SWEEP_MS) return false
    this.sweptAt = now
    return true
  }

  // Returns the ids seen on the previous sweep too, and remembers this sweep's for the next.
  confirm(ids: readonly string[]): Set<string> {
    const confirmed = new Set(ids.filter((id) => this.seen.has(id)))
    this.seen = new Set(ids)
    return confirmed
  }
}
