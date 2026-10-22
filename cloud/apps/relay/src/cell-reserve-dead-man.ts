import { createHash } from 'node:crypto'
import type { CellFlags } from './cell-flags.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'

// A reserve-mode cell keeps its hosts in memory only while a placing director is there to
// book and supersede them. With none for this long (a director rolled back, or placement
// turned off) it flips itself back to db and re-registers, as a switch flip would.
export const RESERVE_DEAD_MAN_MS = 60_000
const RESERVE_DEAD_MAN_SPREAD_MS = 60_000

// 60-120 s, fixed per cell: when every director goes at once, the cells trip (and start
// re-registering against the database) spread over a minute, not together.
export function reserveDeadManWindowMs(cellId: string): number {
  const digest = createHash('sha256').update(cellId).digest()
  return RESERVE_DEAD_MAN_MS + (digest.readUInt32BE(0) % (RESERVE_DEAD_MAN_SPREAD_MS + 1))
}

export class ReserveDeadMan {
  private lastContactAt: number
  private reserveGeneration: number | null = null
  private trippedGeneration: number | null = null

  constructor(
    private readonly cellId: string,
    private readonly now: () => number = Date.now,
    private readonly windowMs = RESERVE_DEAD_MAN_MS,
    private readonly log: (line: string) => void = (line) => console.error(line)
  ) {
    this.lastContactAt = now()
  }

  // A feed poll marked reserver=1, or a real (not dry-run) booking.
  contact(): void {
    this.lastContactAt = this.now()
  }

  // The admitMode the cell acts on. Latched per switch-file generation: once tripped, only a
  // new write brings reserve back, so a director that returns cannot flap the cell.
  mode(applied: AppliedControlFlags<CellFlags>): 'db' | 'reserve' {
    if (applied.flags.admitMode !== 'reserve') {
      this.reserveGeneration = null
      return 'db'
    }
    const now = this.now()
    if (this.reserveGeneration !== applied.generation) {
      // A new reserve write starts its own window.
      this.reserveGeneration = applied.generation
      this.trippedGeneration = null
      this.lastContactAt = Math.max(this.lastContactAt, now)
    }
    if (this.trippedGeneration === applied.generation) return 'db'
    if (now - this.lastContactAt <= this.windowMs) return 'reserve'
    this.trippedGeneration = applied.generation
    this.log(
      JSON.stringify({
        event: 'orca_relay_cell_reserve_dead_man_tripped',
        cellId: this.cellId,
        generation: applied.generation,
        silentMs: now - this.lastContactAt
      })
    )
    return 'db'
  }
}
