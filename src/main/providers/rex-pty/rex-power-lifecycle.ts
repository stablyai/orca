export type RexWakeVerdict = 'healthy' | 'data-lost' | 'control-lost'

type RexWakeOwner = { id: string }

type Entry = {
  probe: () => Promise<RexWakeVerdict>
  lost: (retainControl: boolean) => void
  held: boolean
}

/** Suspend is not process retirement. Wake checks run in bounded batches and
 * obsolete results cannot release a newer suspend's input fence. */
export class RexPowerLifecycle {
  private readonly entries = new Map<RexWakeOwner, Entry>()
  private sleeping = false
  private epoch = 0
  private running?: Promise<void>

  register(key: RexWakeOwner, probe: Entry['probe'], lost: Entry['lost']): () => void {
    const entry = { probe, lost, held: this.sleeping }
    this.entries.set(key, entry)
    return () => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
    }
  }

  generation(): number {
    return this.epoch
  }

  isHeld(key?: RexWakeOwner): boolean {
    return this.sleeping || (key !== undefined && this.entries.get(key)?.held === true)
  }

  suspend(): void {
    this.sleeping = true
    this.epoch++
    for (const entry of this.entries.values()) {
      entry.held = true
    }
  }

  resume(): Promise<void> {
    this.sleeping = false
    this.epoch++
    for (const entry of this.entries.values()) {
      entry.held = true
    }
    this.running ??= this.drain().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async drain(): Promise<void> {
    while (!this.sleeping) {
      const epoch = this.epoch
      const held = [...this.entries].filter(([, entry]) => entry.held)
      if (!held.length) {
        return
      }
      for (let i = 0; i < held.length && !this.sleeping && this.epoch === epoch; i += 8) {
        await Promise.all(
          held.slice(i, i + 8).map(async ([key, entry]) => {
            if (this.entries.get(key) !== entry) {
              return
            }
            const verdict = await entry.probe().catch((): RexWakeVerdict => 'control-lost')
            if (this.sleeping || this.epoch !== epoch || this.entries.get(key) !== entry) {
              return
            }
            entry.held = false
            if (verdict !== 'healthy') {
              entry.lost(verdict === 'data-lost')
            }
          })
        )
      }
    }
  }
}

export const rexPowerLifecycle = new RexPowerLifecycle()
