/**
 * One spool file reader at a time, stale or not, so takeovers during a stalled read can't stack
 * open readers. Waiters hold no callback on the reader itself, and each can be cancelled.
 */
export class SpoolReaderSlot {
  private busy = false
  private readonly waiters = new Set<() => void>()

  get reading(): boolean {
    return this.busy
  }

  /** Resolves when the reader closes its file or `wake` runs; `cancel` ends the wait early. */
  waitForReader(): { done: Promise<void>; cancel: () => void } {
    let cancel!: () => void
    const done = new Promise<void>((resolve) => {
      this.waiters.add(resolve)
      cancel = () => {
        this.waiters.delete(resolve)
        resolve()
      }
    })
    return { done, cancel }
  }

  track<T>(replay: Promise<T>): Promise<T> {
    this.busy = true
    return replay.finally(() => {
      this.busy = false
      this.wake()
    })
  }

  wake(): void {
    for (const resolve of this.waiters) {
      resolve()
    }
    this.waiters.clear()
  }
}
