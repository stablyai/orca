/**
 * Bounded so a host that runs for weeks cannot grow this without limit. Generous because it is one
 * set for the whole host rather than per worktree, and only deliberate closes reach it — a natural
 * shell exit never records, so the churn this has to outlive is operator closes and worker releases.
 */
export const MAX_RETIRED_TERMINAL_PANE_RECORDS = 4096

/**
 * The host's own pane-keyed record that it retired a terminal surface.
 *
 * Separate from the retirement proofs on a session-tab snapshot: those are a client-facing
 * attestation and are keyed by a terminal handle, so a pane the host user created in the desktop
 * renderer and never addressed by handle produces none. This ledger is keyed by the pane alone,
 * which is what a create replaying that pane's ids has to be refused against.
 *
 * In-memory for the process lifetime. A host that restarted no longer holds the closed tab in any
 * form, so there is nothing for a persisted record to protect that the client's own resync does not.
 */
export class RetiredTerminalPaneLedger {
  // Insertion-ordered, so the iteration order below is oldest-first.
  private readonly retiredKeys = new Set<string>()

  private static key(worktreeId: string, tabId: string, leafId: string): string {
    return `${worktreeId}\0${tabId}\0${leafId}`
  }

  /** Records that this pane was retired by a close the user will not undo. */
  record(worktreeId: string, tabId: string, leafId: string): void {
    const key = RetiredTerminalPaneLedger.key(worktreeId, tabId, leafId)
    this.retiredKeys.delete(key)
    this.retiredKeys.add(key)
    while (this.retiredKeys.size > MAX_RETIRED_TERMINAL_PANE_RECORDS) {
      const oldest = this.retiredKeys.values().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.retiredKeys.delete(oldest)
    }
  }

  /** Whether a create replaying this pane's ids must be refused. */
  has(worktreeId: string, tabId: string, leafId: string): boolean {
    return this.retiredKeys.has(RetiredTerminalPaneLedger.key(worktreeId, tabId, leafId))
  }

  /** Called once a PTY is bound to the pane again — a live pane may never be refused. Not at the
   *  create's gate: a spawn that then fails would leave the retirement gone and the next replay
   *  adopted. */
  forget(worktreeId: string, tabId: string, leafId: string): void {
    this.retiredKeys.delete(RetiredTerminalPaneLedger.key(worktreeId, tabId, leafId))
  }

  /** How many panes are currently refusable; the eviction cap is enforced against this. */
  get size(): number {
    return this.retiredKeys.size
  }
}
