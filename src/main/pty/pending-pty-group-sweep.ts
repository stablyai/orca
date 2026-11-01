/** Holds PTY teardown until an in-flight group sweep settles: closing the master first hangs up the root, and the sweep then skips its groups. */
export class PendingPtyGroupSweep {
  private pending: Promise<void> | null = null

  track(sweep: Promise<void>): Promise<void> {
    this.pending = sweep
    const settled = (): void => {
      if (this.pending === sweep) {
        this.pending = null
      }
    }
    sweep.then(settled, settled)
    return sweep
  }

  afterSettled(teardown: () => void): void {
    if (this.pending) {
      this.pending.then(teardown, teardown)
      return
    }
    teardown()
  }
}
