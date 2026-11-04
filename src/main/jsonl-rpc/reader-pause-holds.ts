type PausableReader = { pauseReading(): void; resumeReading(): void }

/** One reader, several pausing owners: reading resumes only when the last hold is released. */
export class ReaderPauseHolds<Owner> {
  private readonly held = new Set<Owner>()

  constructor(private readonly reader: () => PausableReader | undefined) {}

  control(owner: Owner): PausableReader {
    return {
      pauseReading: () => this.set(owner, true),
      resumeReading: () => this.set(owner, false)
    }
  }

  private set(owner: Owner, hold: boolean): void {
    const wasPaused = this.held.size > 0
    if (hold) {
      this.held.add(owner)
    } else {
      this.held.delete(owner)
    }
    const paused = this.held.size > 0
    if (paused !== wasPaused) {
      if (paused) {
        this.reader()?.pauseReading()
      } else {
        this.reader()?.resumeReading()
      }
    }
  }
}
