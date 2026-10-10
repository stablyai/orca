// The cell's raw admit mode in Postgres (relay_cell_admit_effective), so the database path can
// place on a tripped reserve cell even when no director's feed poll reaches it.
export const CELL_ADMIT_EFFECTIVE_REFRESH_MS = 15_000
const CELL_ADMIT_EFFECTIVE_FAILURE_LOG_MS = 60_000

export class CellAdmitEffectiveWriter {
  private written: { mode: 'db' | 'reserve'; at: number } | null = null
  private inFlight = false
  private failureLoggedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly input: {
      write: (mode: 'db' | 'reserve') => Promise<void>
      // Never takes a connection a waiting request needs; the next tick tries again.
      databaseBusy: () => boolean
      now: () => number
      log?: (line: string) => void
    }
  ) {}

  // Best-effort: never awaited, never throws, at most one write in flight.
  tick(mode: 'db' | 'reserve'): void {
    const at = this.input.now()
    const due =
      this.written === null ||
      this.written.mode !== mode ||
      at - this.written.at >= CELL_ADMIT_EFFECTIVE_REFRESH_MS
    if (!due || this.inFlight || this.input.databaseBusy()) return
    this.inFlight = true
    void this.input
      .write(mode)
      .then(() => {
        this.written = { mode, at }
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
