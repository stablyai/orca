type UnprovenExit = { proving: boolean; again: boolean; proof?: Promise<void> }

/** Panes whose process-less agent may have ended unseen: its launch retired on a job stop, or on
 *  a command mark the shell-alone proof refused (a shell nested in the live agent). Each later
 *  mark re-proves; one proof per pane runs at a time, and a mark during it asks for one more. */
export class UnprovenAgentExits {
  private readonly panes = new Map<string, UnprovenExit>()

  /** `prove` answers whether the pane is settled: its agent's exit was confirmed. */
  constructor(private readonly prove: (paneKey: string) => Promise<boolean>) {}

  /** A launch retired; `unseen`: its agent may still end unseen, `proveNow`: a mark said it ended.
   *  Replaces any earlier entry, so a proof still running for that one no longer counts. */
  launchRetired(paneKey: string, unseen: boolean, proveNow: boolean): void {
    if (!unseen) {
      this.panes.delete(paneKey)
      return
    }
    this.panes.set(paneKey, { proving: false, again: false })
    if (proveNow) {
      this.onCommandFinished(paneKey)
    }
  }

  has(paneKey: string): boolean {
    return this.panes.has(paneKey)
  }

  forget(paneKey: string): void {
    this.panes.delete(paneKey)
  }

  forgetWhere(matches: (paneKey: string) => boolean): void {
    for (const paneKey of this.panes.keys()) {
      if (matches(paneKey)) {
        this.panes.delete(paneKey)
      }
    }
  }

  /** `unseen`: arm a pane no earlier retirement armed, whose agent may still end unseen. */
  onCommandFinished(paneKey: string, unseen = false): void {
    if (unseen && !this.panes.has(paneKey)) {
      this.panes.set(paneKey, { proving: false, again: false })
    }
    const entry = this.panes.get(paneKey)
    if (!entry || entry.proving) {
      if (entry) {
        entry.again = true
      }
      return
    }
    entry.proving = true
    entry.again = false
    entry.proof = this.prove(paneKey)
      .catch(() => false)
      .then((settled) => {
        if (this.panes.get(paneKey) !== entry) {
          return
        }
        entry.proving = false
        if (settled) {
          this.panes.delete(paneKey)
        } else if (entry.again) {
          this.onCommandFinished(paneKey)
        }
      })
  }

  /** Answers a sleep capture with one current proof: the running one, else a fresh one for a pane
   *  still tracked (its last proof may have been voided by input). Queued re-proofs aren't
   *  awaited, so marks arriving faster than proofs can't hold a sleep back. */
  async settled(paneKey: string): Promise<void> {
    const entry = this.panes.get(paneKey)
    if (entry && !entry.proving) {
      this.onCommandFinished(paneKey)
    }
    await entry?.proof
  }
}
