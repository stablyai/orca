export const SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS = 30_000

/**
 * Why: a close kills its PTY asynchronously, so for a short window other
 * devices can still see the PTY alive but absent from the snapshot and either
 * stall their frame pipeline on a "live-unresolved orphan" or re-adopt the
 * dying process, resurrecting the closed session fleet-wide. Tombstones mark
 * recently closed host tabs (and their killed/kill-pending PTYs) so inventory
 * and adoption treat them as closed until the kill has settled.
 */
export class SessionTabCloseTombstoneStore {
  private readonly closedTabExpiryByWorktree = new Map<string, Map<string, number>>()
  private readonly closedPtyExpiryByWorktree = new Map<string, Map<string, number>>()

  record(worktreeId: string, hostTabId: string, now = Date.now()): void {
    this.recordEntry(this.closedTabExpiryByWorktree, worktreeId, hostTabId, now)
  }

  recordPty(worktreeId: string, ptyId: string, now = Date.now()): void {
    this.recordEntry(this.closedPtyExpiryByWorktree, worktreeId, ptyId, now)
  }

  /** Host tab ids closed within the TTL, for the snapshot's recentlyClosedTabIds. */
  activeIds(worktreeId: string, now = Date.now()): string[] {
    const entries = this.sweep(this.closedTabExpiryByWorktree, worktreeId, now)
    return entries ? [...entries.keys()] : []
  }

  isTabTombstoned(worktreeId: string, hostTabId: string, now = Date.now()): boolean {
    return this.sweep(this.closedTabExpiryByWorktree, worktreeId, now)?.has(hostTabId) === true
  }

  isPtyTombstoned(worktreeId: string, ptyId: string, now = Date.now()): boolean {
    return this.sweep(this.closedPtyExpiryByWorktree, worktreeId, now)?.has(ptyId) === true
  }

  private recordEntry(
    expiryByWorktree: Map<string, Map<string, number>>,
    worktreeId: string,
    id: string,
    now: number
  ): void {
    const entries = this.sweep(expiryByWorktree, worktreeId, now) ?? new Map<string, number>()
    entries.set(id, now + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS)
    expiryByWorktree.set(worktreeId, entries)
  }

  // Lazy sweep: expired entries are dropped whenever their worktree is touched.
  private sweep(
    expiryByWorktree: Map<string, Map<string, number>>,
    worktreeId: string,
    now: number
  ): Map<string, number> | null {
    const entries = expiryByWorktree.get(worktreeId)
    if (!entries) {
      return null
    }
    for (const [id, expiresAt] of entries) {
      if (expiresAt <= now) {
        entries.delete(id)
      }
    }
    if (entries.size === 0) {
      expiryByWorktree.delete(worktreeId)
      return null
    }
    return entries
  }
}
