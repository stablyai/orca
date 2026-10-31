import { DEAD_MAN_SLOT_HOLD_MS } from './cell-dead-man-trip-slot.js'

// Publish raw mode so DB placement can use tripped reserve cells despite unreachable feeds. Write while switch says reserve plus one db exit write; step 5 off adds no writes.
export const CELL_ADMIT_EFFECTIVE_REFRESH_MS = 15_000
const CELL_ADMIT_EFFECTIVE_FAILURE_LOG_MS = 60_000
// A held dead-man asks for a trip slot this often; each ask is one short locked transaction.
export const DEAD_MAN_SLOT_CLAIM_RETRY_MS = 30_000
// A tripped cell's db row holds its slot, so a saturated pool still refreshes it well inside the hold.
const TRIPPED_ROW_BUSY_OVERRIDE_MS = DEAD_MAN_SLOT_HOLD_MS / 2

export class CellAdmitEffectiveWriter {
  private written: { mode: 'db' | 'reserve'; at: number } | null = null
  private inFlight = false
  // A reserve row may stand: the db write that replaces it is still owed.
  private owed = false
  private failureLoggedAt = Number.NEGATIVE_INFINITY
  private claimedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly input: {
      write: (mode: 'db' | 'reserve') => Promise<void>
      // Writes db only while fewer than `slots` other reserve cells' rows say db; true if it did.
      claimTrip?: (slots: number) => Promise<boolean>
      // Never takes a connection a waiting request needs; the next tick tries again.
      databaseBusy: () => boolean
      now: () => number
      log?: (line: string) => void
    }
  ) {}

  // Best-effort: never awaited, never throws, at most one write in flight. `switchReserve` is the
  // applied switch file's admitMode (a tripped dead-man keeps it reserve, with `mode` db).
  // `trip` is a held dead-man's slot claim. It goes through here so that no reserve write still
  // in flight can land after it and hide the slot from the next claimant.
  tick(
    rawMode: 'db' | 'reserve',
    switchReserve: boolean,
    trip?: { slots: number; permit: () => void } | null
  ): void {
    if (switchReserve) this.owed = true
    else if (!this.owed) return
    else if (this.written?.mode === 'db' && !this.inFlight) {
      this.owed = false
      return
    }
    const at = this.input.now()
    const trippedRowOverdue =
      switchReserve &&
      rawMode === 'db' &&
      this.written?.mode === 'db' &&
      at - this.written.at >= TRIPPED_ROW_BUSY_OVERRIDE_MS
    if (this.inFlight || (this.input.databaseBusy() && !trippedRowOverdue)) {
      return
    }
    const claimTrip = this.input.claimTrip
    if (switchReserve && trip && claimTrip && at - this.claimedAt >= DEAD_MAN_SLOT_CLAIM_RETRY_MS) {
      this.claimedAt = at
      this.settle('db', at, switchReserve, claimTrip(trip.slots).then((claimed) => {
        if (claimed) {
          trip.permit()
        }
        return claimed
      }))
      return
    }
    const mode = switchReserve ? rawMode : 'db'
    const due =
      this.written === null ||
      this.written.mode !== mode ||
      at - this.written.at >= CELL_ADMIT_EFFECTIVE_REFRESH_MS
    if (due) {
      this.settle(mode, at, switchReserve, this.input.write(mode).then(() => true))
    }
  }

  // `write` resolves false when it wrote nothing (a claim with every slot taken).
  private settle(mode: 'db' | 'reserve', at: number, switchReserve: boolean, write: Promise<boolean>): void {
    this.inFlight = true
    void write
      .then((wrote) => {
        if (!wrote) {
          return
        }
        this.written = { mode, at }
        if (!switchReserve) {
          this.owed = false
        }
      })
      .catch((error: unknown) => {
        if (at - this.failureLoggedAt < CELL_ADMIT_EFFECTIVE_FAILURE_LOG_MS) return
        this.failureLoggedAt = at
        ;(this.input.log ?? ((line: string) => console.warn(line)))(
          JSON.stringify({
            event: 'orca_relay_cell_admit_effective_write_failed',
            mode,
            reason: error instanceof Error ? error.message : 'unknown'
          })
        )
      })
      .finally(() => {
        this.inFlight = false
      })
  }
}
