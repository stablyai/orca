/** A disposable process-local admission to mutate one history ID; once closed it never reopens. */
export type HistoryWriterAdmission = {
  /** Settles when every predecessor's already-issued file work has actually settled. */
  readonly ready: Promise<void>
  current: () => boolean
  release: () => void
}

type WriterClaim = HistoryWriterAdmission & { owner: object }

/** Reuse waits for actual predecessor work; abandoning a caller cannot cancel filesystem writes. */
export class TerminalHistoryWriterHandoff {
  private readonly claims = new Map<string, WriterClaim>()
  private readonly pending = new Map<string, Set<Promise<void>>>()
  private admitting = 0

  constructor(private readonly onIdle: () => void) {}

  get idle(): boolean {
    return this.admitting === 0 && this.claims.size === 0 && this.pending.size === 0
  }

  /**
   * A new owner synchronously closes and detaches its predecessor, then waits on that owner's
   * actual tail. `retire` must detach synchronously and return only work already issued.
   */
  admitWriter(
    id: string,
    owner: object,
    retire: () => Promise<void> | undefined,
    opts: { ifUnclaimed: true }
  ): HistoryWriterAdmission | undefined
  admitWriter(
    id: string,
    owner: object,
    retire: () => Promise<void> | undefined
  ): HistoryWriterAdmission
  admitWriter(
    id: string,
    owner: object,
    retire: () => Promise<void> | undefined,
    opts: { ifUnclaimed?: true } = {}
  ): HistoryWriterAdmission | undefined {
    const previous = this.claims.get(id)
    if (previous?.owner === owner && previous.current()) {
      return previous
    }
    if (opts.ifUnclaimed && previous?.current()) {
      // Cleanup never takes an ID back from a live successor.
      return undefined
    }
    // Hold idleness while ownership switches so the root cannot be dropped and split.
    this.admitting += 1
    try {
      previous?.release()
      let open = true
      const claim: WriterClaim = {
        owner,
        ready: Promise.allSettled(this.pending.get(id) ?? []).then(() => {}),
        current: () => open && this.claims.get(id) === claim,
        release: () => {
          if (!open) {
            return
          }
          open = false
          if (this.claims.get(id) === claim) {
            this.claims.delete(id)
          }
          let work: Promise<void> | undefined
          try {
            work = retire()
          } catch {
            // Detachment failed before issuing work; the closed token still blocks every later call.
          }
          if (work) {
            this.track(id, work)
          }
          this.onIdle()
        }
      }
      this.claims.set(id, claim)
      return claim
    } finally {
      this.admitting -= 1
    }
  }

  private track(id: string, work: Promise<void>): void {
    const pending = this.pending.get(id) ?? new Set<Promise<void>>()
    pending.add(work)
    this.pending.set(id, pending)
    const settled = (): void => {
      pending.delete(work)
      if (pending.size === 0 && this.pending.get(id) === pending) {
        this.pending.delete(id)
      }
      this.onIdle()
    }
    void work.then(settled, settled)
  }
}
