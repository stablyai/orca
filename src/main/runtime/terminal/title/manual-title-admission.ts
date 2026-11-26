import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** A conditional rename's admission, read from the partition inside the durable write: refuse when the tab's manual name differs. */
export function manualTitleAdmission(
  partitions: readonly WorkspaceSessionState[] | undefined,
  pane: { worktreeId: string; tabId: string },
  expected: string
): boolean | 'terminal_title_changed' {
  const tab = partitions?.[0]?.tabsByWorktree[pane.worktreeId]?.find(
    (candidate) => candidate.id === pane.tabId
  )
  if (!tab) {
    return false
  }
  return (tab.customTitle?.trim() || '') === expected.trim() || 'terminal_title_changed'
}

// Long enough for the window to apply and save a rename; a rename that never lands stops blocking after it.
const WINDOW_RENAME_LANDING_MS = 5000

/** Renames sent to the window but not yet seen in its saved tab, by handle. The window saves them asynchronously. */
export class UnlandedWindowRenames {
  private readonly sent = new Map<string, { before: string; sentAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  record(handle: string, before: string, title: string | null): void {
    for (const [key, entry] of this.sent) {
      if (this.now() - entry.sentAt >= WINDOW_RENAME_LANDING_MS) {
        this.sent.delete(key)
      }
    }
    if ((title?.trim() || '') !== before) {
      this.sent.set(handle, { before, sentAt: this.now() })
    }
  }

  /** True while the saved name still reads as it did before the last rename sent for this handle. */
  inFlight(handle: string, saved: string): boolean {
    const entry = this.sent.get(handle)
    if (entry && saved === entry.before && this.now() - entry.sentAt < WINDOW_RENAME_LANDING_MS) {
      return true
    }
    this.sent.delete(handle)
    return false
  }
}
