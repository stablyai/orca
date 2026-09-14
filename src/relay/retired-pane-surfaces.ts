/**
 * PaneKeys whose client surface the host has been told is gone — a `pty.shutdown` arrived for the
 * PTY bound to them — but whose host-side process the relay has not proven dead.
 *
 * Retirement is deliberately NOT a liveness verdict. Per docs/reference/ssh-execution-boundary.md
 * the vocabulary stays `live` / `unverifiable` / `exited`, and this registry asserts none of them
 * about the process: it records only that no client tab can own this pane any more. That is the
 * fact the relay needs to tell an orphaned agent's hook post apart from a live agent pane, and it
 * is knowable without guessing, because the client stated it.
 */

/** Bounded so a long-lived relay cannot accumulate one entry per pane ever closed. Insertion order
 *  is age, so eviction drops the longest-retired pane first; an evicted pane simply degrades to the
 *  pre-fix behaviour (its posts are forwarded again) rather than failing. */
export const RETIRED_PANE_SURFACE_LIMIT = 512

export class RetiredPaneSurfaceRegistry {
  private readonly retired = new Set<string>()

  retire(paneKey: string): void {
    if (!paneKey) {
      return
    }
    // Delete-then-add makes iteration order = recency of retirement for the cap below.
    this.retired.delete(paneKey)
    this.retired.add(paneKey)
    while (this.retired.size > RETIRED_PANE_SURFACE_LIMIT) {
      const oldest = this.retired.values().next().value
      if (oldest === undefined) {
        break
      }
      this.retired.delete(oldest)
    }
  }

  /** A PTY joining the pool under this paneKey means the surface exists again — the user reopened
   *  the pane, or a revive re-bound it — so the retirement no longer describes anything. */
  restore(paneKey: string): void {
    if (paneKey) {
      this.retired.delete(paneKey)
    }
  }

  isRetired(paneKey: string): boolean {
    return Boolean(paneKey) && this.retired.has(paneKey)
  }

  get size(): number {
    return this.retired.size
  }

  clear(): void {
    this.retired.clear()
  }
}
